import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import {getVideo, updateVideo} from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import {BadRequestError, NotFoundError, UserForbiddenError} from "./errors";
import * as path from "node:path";
import {getAssetDiskPath, getAssetURL, mediaTypeExt} from "./assets.ts";
import {randomBytes} from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

	const formData = await req.formData();
	const img = formData.get("thumbnail");
	if (!(img instanceof File)) {
		throw new BadRequestError("Invalid file");
	}

	const MAX_UPLOAD_SIZE = 10 << 20;
	if (img.size > MAX_UPLOAD_SIZE) {
		throw new BadRequestError("File too large");
	}

	const video = getVideo(cfg.db, videoId);
	if (!video) {
		throw new NotFoundError("Couldn't find video");
	}

	if (video.userID !== userID) {
		throw new UserForbiddenError("You do not have permission to upload thumbnail");
	}

	const type = img.type;
	if (type !== "image/jpeg" && type !== "image/png") {
		throw new BadRequestError("Invalid file format");
	}

	const ext = mediaTypeExt(img.type);
	const arrBuff = await img.arrayBuffer();

	const identifier = randomBytes(32).toString("base64url");
	const thumbnailPath = `${identifier}.${ext}`;
	const writePath = getAssetDiskPath(cfg, thumbnailPath);
	await Bun.write(writePath, arrBuff);

	videoThumbnails.set(identifier, {
		data: arrBuff,
		mediaType: type,
	});

	video.thumbnailURL = getAssetURL(cfg, thumbnailPath);
	updateVideo(cfg.db, video);

	return respondWithJSON(200, video);
}
