import multer from 'multer'

export const MAX_UPLOAD_BYTES = 50_000_000

export function createUpload({fileSize = MAX_UPLOAD_BYTES} = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {fileSize}
  })
}
