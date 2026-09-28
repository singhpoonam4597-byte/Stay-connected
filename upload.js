import express from 'express';
import multer from 'multer';

const router = express.Router();

// In-memory upload (no S3 required). Stores image as data URL in DB.
// Limit 2MB — fine for chat photos on Neon MVP.
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
      return res.status(400).json({
        error: err.message || 'Upload failed',
        code: 'UPLOAD_ERROR',
      });
    }
    next();
  });
}

/**
 * POST /api/upload/message-attachment
 * form-data: file (image)
 * returns { attachment: { id, fileUrl, mimeType, fileName, fileSize } }
 * Note: attachment is not linked to a message yet — link on send message.
 */
router.post('/message-attachment', runUpload, async (req, res) => {
  try {
    const { prisma } = await import('./server.js');
    const userId = req.user?.id || req.userId;

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
        fileName: req.file.originalname || 'image.jpg',
        fileSize: BigInt(req.file.size || 0),
        fileType: mime.split('/')[1] || 'image',
        fileUrl: dataUrl,
        mimeType: mime,
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
      error: 'Failed to upload file',
      code: 'UPLOAD_ERROR',
    });
  }
});

router.post('/avatar', runUpload, async (req, res) => {
  try {
    const { prisma } = await import('./server.js');
    const userId = req.user?.id || req.userId;

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
    res.status(500).json({ error: 'Failed to upload avatar', code: 'UPLOAD_ERROR' });
  }
});

export default router;
