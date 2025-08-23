import {respondWithJSON} from "./json";

import {type ApiConfig, cfg} from "../config";
import type {BunRequest} from "bun";
import {BadRequestError, NotFoundError, UserForbiddenError} from "./errors.ts";
import {getBearerToken, validateJWT} from "../auth.ts";
import {getVideo, updateVideo, type Video} from "../db/videos.ts";
import {randomBytes} from "crypto";
import * as path from "node:path";
import {rm} from "node:fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
	const UPLOAD_LIMIT = 1 << 30;
	const {videoId} = req.params as { videoId?: string };
	if (!videoId) {
		console.log("Invalid video ID");
		throw new BadRequestError("Invalid video ID");
	}

	const token = getBearerToken(req.headers);
	const userId = validateJWT(token, cfg.jwtSecret);

	const video = await getVideo(cfg.db, videoId);
	if (!video) {
		console.log("Video not found");
		throw new NotFoundError("Video not found");
	}
	if (video.userID !== userId) {
		console.log("You do not have permissions");
		throw new UserForbiddenError("You do not have permissions");
	}

	const formData = await req.formData();
	const videoData = formData.get("video");
	if (!(videoData instanceof Blob)) {
		console.log("Invalid file type");
		throw new BadRequestError("Invalid file type");
	}

	if (videoData.size > UPLOAD_LIMIT) {
		console.log("Video type is too large");
		throw new BadRequestError("Video size is too large");
	}

	if (videoData.type !== "video/mp4") {
		console.log("Invalid file type");
		throw new NotFoundError("Invalid file type");
	}

	const videoName = randomBytes(32).toString("hex");
	const tempPath = path.join(cfg.filepathRoot, `/assets/temp/${videoName}.mp4`);
	const videoBuffer = await videoData.arrayBuffer();
	await Bun.write(tempPath, videoBuffer);
	console.log(`Writing video buffer at: ${tempPath}`);

	const aspectRatio = await getVideoAspectRatio(tempPath);
	const key = `${aspectRatio}/${videoName}.mp4`;

	const processedTempPath = await processVideoForFastStart(tempPath);
	const file = Bun.file(processedTempPath);
	console.log(file.text());
	await cfg.s3Client.write(key, file, {type: "video/mp4"});

	video.videoURL = `https://${cfg.s3CfDistribution}/${key}`
	updateVideo(cfg.db, video);
	await rm(tempPath);
	await rm(processedTempPath);

	return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
	const process = Bun.spawn([
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height",
			"-of",
			"json",
			filePath,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const outputText = await new Response(process.stdout).text();
	const errorText = await new Response(process.stderr).text();

	const exitCode = await process.exited;

	if (exitCode !== 0) {
		throw new Error(`ffprobe error: ${errorText}`);
	}

	const output = JSON.parse(outputText);
	if (!output.streams || output.streams.length === 0) {
		throw new Error("No video streams found");
	}

	const {width, height} = output.streams[0];

	return width === Math.floor(16 * (height / 9))
		? "landscape"
		: height === Math.floor(16 * (width / 9))
			? "portrait"
			: "other";
}

async function processVideoForFastStart(inputFilePath: string) {
	const outputPath = `${inputFilePath}.processed.mp4`;
	const process = Bun.spawn([
			"ffmpeg",
			"-i",
			inputFilePath,
			"-movflags",
			"faststart",
			"-map_metadata",
			"0",
			"-codec",
			"copy",
			"-f",
			"mp4",
			outputPath
		],
		{
			stderr: "pipe",
		}
	);

	const errorText = await new Response(process.stderr).text();
	const exitCode = await process.exited;

	if (exitCode !== 0) {
		throw new Error(`ffmpeg error: ${errorText}`);
	}

	return outputPath;
}
