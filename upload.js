import express from 'express';
import multer from 'multer';
import { prisma } from './server.js';

const router = express.Router();

// In-memory image upload (no S3). Max 2MB. Stored as data URL in DB for MVP.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    cb(null, true);
  },
});

function runUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be under 2MB'
          : err.message || 'Upload failed';
      return res.status(400).json({
        error: msg,
        code: 'UPLOAD_ERROR',
      });
    }
    next();
  });
}

/**
 * POST /api/upload/message-attachment
 * form-data field name: file
 */
router.post('/message-attachment', runUpload, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No file provided',
        code: 'MISSING_FILE',
      });
    }

    const mime = req.file.mimetype || 'image/jpeg';
    const b64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${b64}`;

    const attachment = await prisma.attachment.create({
      data: {
        uploadedBy: userId,
        fileName: (req.file.originalname || 'image.jpg').slice(0, 255),
        fileSize: BigInt(req.file.size || 0),
        fileType: (mime.split('/')[1] || 'image').slice(0, 100),
        fileUrl: dataUrl,
        mimeType: mime.slice(0, 100),
        messageId: null,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        attachment: {
          id: attachment.id,
          fileUrl: attachment.fileUrl,
          mimeType: attachment.mimeType,
          fileName: attachment.fileName,
          fileSize: Number(attachment.fileSize),
        },
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: error?.message || 'Failed to upload file',
      code: 'UPLOAD_ERROR',
    });
  }
});

router.post('/avatar', runUpload, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided', code: 'MISSING_FILE' });
    }

    const mime = req.file.mimetype || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;

    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatar: dataUrl },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
      },
    });

    res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({
      error: error?.message || 'Failed to upload avatar',
      code: 'UPLOAD_ERROR',
    });
  }
});

export default router;
