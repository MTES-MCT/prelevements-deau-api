import process from 'node:process'
import {
  S3,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'

const {S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET} = process.env

if (process.env.NODE_ENV === 'production' && (!S3_ENDPOINT || !S3_REGION || !S3_ACCESS_KEY || !S3_SECRET_KEY || !S3_BUCKET)) {
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

export async function uploadObject(objectKey, buffer, moreParams = {}) {
  const upload = new Upload({
    client,
    params: {
      Bucket: S3_BUCKET,
      Key: objectKey,
      Body: buffer,
      ...moreParams
    }
  })

  await upload.done()
}

export async function downloadFile(objectKey) {
  const command = new GetObjectCommand({Bucket: S3_BUCKET, Key: objectKey})
  const {Body} = await client.send(command)

  // Convertir le flux de données en buffer
  const buffer = await streamToBuffer(Body)
  return buffer
}

// Fonction utilitaire pour convertir un flux en buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

export async function objectExists(objectKey) {
  try {
    await getFileRawMetadata(objectKey)
    return true
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false
    }

    throw error
  }
}

export async function getFileSize(objectKey) {
  const metadata = await getFileRawMetadata(objectKey)
  return metadata.ContentLength
}

export async function getFileRawMetadata(objectKey) {
  const command = new HeadObjectCommand({Bucket: S3_BUCKET, Key: objectKey})
  return client.send(command)
}

export async function deleteObject(objectKey) {
  const command = new DeleteObjectCommand({Bucket: S3_BUCKET, Key: objectKey})
  const result = await client.send(command)
  return result
}
