import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Private object storage. Keys are server-generated; never derived from user-supplied filenames. */
export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements StorageAdapter {
  private root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  get(key: string) { return readFile(this.path(key)); }
  async delete(key: string) { await unlink(this.path(key)).catch(() => undefined); }
}

/** S3-compatible storage (AWS S3, MinIO, etc.). Credentials come from the standard AWS env chain. */
export class S3Storage implements StorageAdapter {
  private client: S3Client;
  constructor(private bucket: string, endpoint?: string, region = 'ap-south-1') {
    this.client = new S3Client({ region, endpoint, forcePathStyle: Boolean(endpoint) });
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

export function createStorage(env: Record<string, string | undefined> = process.env): StorageAdapter {
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
    return new S3Storage(env.S3_BUCKET, env.S3_ENDPOINT || undefined, env.S3_REGION || undefined);
  }
  return new LocalStorage(env.STORAGE_LOCAL_PATH || './.storage');
}
