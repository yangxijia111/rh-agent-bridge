/**
 * ResourceService：素材上传（FR-08、04 §10）。
 * 返回官方 fileName（相对路径）；严禁拼接公共 URL。
 */
import type { RunningHubClient } from "../clients/runninghub/client.js";
import type { UploadResult } from "../clients/runninghub/upload.js";

export class ResourceService {
  constructor(private readonly rh: RunningHubClient) {}

  async upload(filePath: string, fileType = "input"): Promise<UploadResult> {
    return this.rh.uploadApi.uploadResource(filePath, fileType);
  }
}
