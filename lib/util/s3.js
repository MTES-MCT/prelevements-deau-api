import process from 'node:process'
import {
  S3,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'

const {S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET_PREFIX} = process.env

if (process.env.NODE_ENV === 'production' && (!S3_ENDPOINT || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET_PREFIX)) {
  throw new Error('S3 configuration error')
}

const client = new S3({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  s3BucketEndpoint: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY
  }
})

class StorageClient {
  constructor(bucketName) {
    this.bucketName = bucketName
    this.fullBucketName = `${S3_BUCKET_PREFIX}${bucketName}`
  }

  async uploadObject(objectKey, buffer) {
    const upload = new Upload({
      client,
      params: {
        Bucket: this.fullBucketName,
        Key: objectKey,
        Body: buffer
      }
    })

    await upload.done()
  }

  async downloadObject(objectKey) {
    const command = new GetObjectCommand({Bucket: this.fullBucketName, Key: objectKey})
    const {Body} = await client.send(command)

    // Convert data stream to buffer
    const buffer = await streamToBuffer(Body)
    return buffer
  }

  async objectExists(objectKey) {
    try {
      await this.getFileRawMetadata(objectKey)
      return true
    } catch (error) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }

      throw error
    }
  }

  async getFileRawMetadata(objectKey) {
    const command = new HeadObjectCommand({Bucket: this.fullBucketName, Key: objectKey})
    return client.send(command)
  }

  async getFileSize(objectKey) {
    const metadata = await this.getFileRawMetadata(objectKey)
    return metadata.ContentLength
  }

  async deleteObject(objectKey) {
    const command = new DeleteObjectCommand({Bucket: this.fullBucketName, Key: objectKey})
    const result = await client.send(command)
    return result
  }
}

export default function createStorageClient(bucketName) {
  return new StorageClient(bucketName)
}

/* Helpers */

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

