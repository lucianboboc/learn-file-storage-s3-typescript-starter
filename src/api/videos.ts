import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import {BadRequestError, NotFoundError, UserForbiddenError} from "./errors.ts";
import {getBearerToken, validateJWT} from "../auth.ts";
import {getVideo, updateVideo} from "../db/videos.ts";
import {randomBytes} from "crypto";
import * as path from "node:path";
import { rm } from "node:fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
	const UPLOAD_LIMIT = 1 << 30;
	const {videoId} = req.params as {videoId?: string};
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

	const key = `${videoName}.mp4`;
	const file = Bun.file(tempPath);
	await cfg.s3Client.write(key, file, {type: "video/mp4"});

	video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`
	updateVideo(cfg.db, video);
	await rm(tempPath);

  return respondWithJSON(200, video);
}
