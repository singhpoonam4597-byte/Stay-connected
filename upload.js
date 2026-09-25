import express from 'express';

const router = express.Router();

/**
 * Uploads disabled until object storage (S3 / R2 / Cloudinary) is configured.
 * Set UPLOADS_ENABLED=true and wire storage later to re-enable.
 */
const uploadsEnabled = process.env.UPLOADS_ENABLED === 'true';

function disabled(req, res) {
  return res.status(503).json({
    error: 'File uploads are temporarily disabled. Object storage is not configured yet.',
    code: 'UPLOADS_DISABLED',
  });
}

if (!uploadsEnabled) {
  router.post('/avatar', disabled);
  router.post('/message-attachment', disabled);
  router.post('/message-attachments', disabled);
  router.delete('/attachment/:attachmentId', disabled);
} else {
  // Placeholder: re-add multer + storage implementation when ready
  router.post('/avatar', disabled);
  router.post('/message-attachment', disabled);
  router.post('/message-attachments', disabled);
  router.delete('/attachment/:attachmentId', disabled);
}

export default router;
