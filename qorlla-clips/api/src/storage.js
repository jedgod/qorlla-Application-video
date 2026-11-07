/**
 * Object storage (AWS S3 or any S3-compatible store such as MinIO), used for recordings.
 *
 * Two clients are kept on purpose:
 *   - `client`   talks to the store from the API (S3_ENDPOINT, possibly a private address like http://minio:9000)
 *   - `signer`   builds the URLs handed to BROWSERS (S3_PUBLIC_ENDPOINT, an address the browser can reach, like http://localhost:9100)
 * Presigned URLs embed the host they were signed for, so signing with the private address would produce links the browser cannot use.
 *
 * The API never proxies video bytes: browsers upload parts to, and stream playback from, the store using short-lived signed URLs.
 */
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, CreateBucketCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function createStorage(cfg) {
  const base = {
    region: cfg.region || 'us-east-1',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: !!cfg.forcePathStyle,
    // newer SDK versions add checksum headers by default; many S3-compatible stores do not understand them
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  const client = new S3Client({ ...base, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}) });
  const signer = cfg.publicEndpoint ? new S3Client({ ...base, endpoint: cfg.publicEndpoint }) : client;
  const Bucket = cfg.bucket;

  return {
    bucket: Bucket,

    /** Development convenience (S3_AUTO_CREATE_BUCKET=1). In production the bucket is created and secured by you. */
    async ensureBucket() {
      try { await client.send(new HeadBucketCommand({ Bucket })); }
      catch (e) {
        if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') await client.send(new CreateBucketCommand({ Bucket }));
        else throw e;
      }
    },

    async startMultipart(key, contentType) {
      const r = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType, ...(cfg.sse ? { ServerSideEncryption: cfg.sse } : {}) }));
      return r.UploadId;
    },

    /**
     * One signed URL for one part. The part's exact length is part of the signature, so a browser cannot send more (or fewer)
     * bytes than the server expects for that part.
     */
    async signPart(key, uploadId, partNumber, contentLength, expiresIn) {
      return getSignedUrl(signer, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: contentLength }), {
        expiresIn, signableHeaders: new Set(['content-length']),
      });
    },

    /** What the store really holds for this upload: the authority for completion (the browser's claims are never used). */
    async listParts(key, uploadId) {
      const out = []; let marker;
      for (;;) {
        const r = await client.send(new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }));
        for (const p of r.Parts || []) out.push({ partNumber: p.PartNumber, size: Number(p.Size), etag: p.ETag });
        if (!r.IsTruncated) break;
        marker = r.NextPartNumberMarker;
      }
      return out;
    },

    async complete(key, uploadId, parts) {
      return client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) } }));
    },

    async abort(key, uploadId) {
      try { await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })); }
      catch (e) { if (e?.name !== 'NoSuchUpload' && e?.$metadata?.httpStatusCode !== 404) throw e; }     // already gone is fine
    },

    /** Size and type of a finished object, or null if it does not exist. */
    async head(key) {
      try { const r = await client.send(new HeadObjectCommand({ Bucket, Key: key })); return { size: Number(r.ContentLength), contentType: r.ContentType }; }
      catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null; throw e; }
    },

    /** A short-lived link for the browser to stream the video. */
    async signGet(key, { expiresIn, contentType }) {
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key, ResponseContentType: contentType || undefined, ResponseContentDisposition: 'inline' }), { expiresIn });
    },

    async remove(key) {
      try { await client.send(new DeleteObjectCommand({ Bucket, Key: key })); }
      catch (e) { if (e?.$metadata?.httpStatusCode !== 404) throw e; }
    },
  };
}
