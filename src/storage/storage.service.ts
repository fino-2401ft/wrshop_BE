import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3?: S3Client;
  private readonly bucket?: string;
  private readonly publicBase?: string;
  private readonly localDir = join(process.cwd(), 'uploads');

  constructor(private readonly config: ConfigService) {
    const accountId = config.get<string>('R2_ACCOUNT_ID')?.trim();
    const accessKeyId = config.get<string>('R2_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY')?.trim();
    const bucket = config.get<string>('R2_BUCKET')?.trim();
    const publicBase = config.get<string>('R2_PUBLIC_URL')?.trim().replace(/\/$/, '');
    if (accountId && accessKeyId && secretAccessKey && bucket && publicBase) {
      this.s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
      this.bucket = bucket;
      this.publicBase = publicBase;
      this.logger.log('Ảnh sẽ được lưu trên Cloudflare R2');
    } else {
      this.logger.warn('R2 chưa cấu hình. Ảnh lưu tạm trong uploads');
    }
  }

  async upload(accountId: string, buffer: Buffer, mime: string) {
    const ext = EXTENSIONS[mime] ?? '';
    const key = `accounts/${accountId}/${randomUUID()}${ext}`;
    if (this.s3 && this.bucket && this.publicBase) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: mime,
        }),
      );
      return { key, url: `${this.publicBase}/${key}` };
    }

    const target = join(this.localDir, ...key.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    );
    return { key, url: `${base}/uploads/${key}` };
  }

  async remove(key: string) {
    if (this.s3 && this.bucket) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    const target = join(this.localDir, ...key.split('/'));
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
