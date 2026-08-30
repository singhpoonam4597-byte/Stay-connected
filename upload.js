import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from './server.js';

const router = express.Router();

const uploadDir = process.env.UPLOAD_DIR || './uploads';
const maxFileSize = parseInt(process.env.MAX_FILE_SIZE || '10485760');
const allowedMimeTypes = (process.env.ALLOWED_MIME_TYPES || 'image/jpeg,image/png,image/gif,image/webp').split(',');

await fs.mkdir(uploadDir, { recursive: true }).catch(() => {});
await fs.mkdir(path.join(uploadDir, 'avatars'), { recursive: true }).catch(() => {});
await fs.mkdir(path.join(uploadDir, 'messages'), { recursive: true }).catch(() => {});

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return cb(new Error(`File type ${file.mimetype} is not allowed`));
  }
  if (file.size > maxFileSize) {
    return cb(new Error(`File size exceeds maximum of ${maxFileSize} bytes`));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: maxFileSize,
    files: 10
  }
});

async function processAndSaveImage(file, targetDir, maxWidth = 1000, maxHeight = 1000) {
  try {
    const fileName = `${uuidv4()}.webp`;
    const filePath = path.join(uploadDir, targetDir, fileName);

    const processedBuffer = await sharp(file.buffer)
      .resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 80 })
      .toBuffer();

    await fs.writeFile(filePath, processedBuffer);

    return {
      fileName,
      fileSize: processedBuffer.length,
      fileUrl: `${process.env.FRONTEND_URL}/uploads/${targetDir}/${fileName}`,
      localPath: filePath
    };
  } catch (error) {
    throw new Error(`Image processing failed: ${error.message}`);
  }
}

async function validateUserExists(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true }
  });

  if (!user) {
    throw new Error('User not found');
  }

  return user;
}

router.post('/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file provided',
        code: 'NO_FILE'
      });
    }

    const userId = req.userId;

    await validateUserExists(userId);

    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({
        error: 'File must be an image',
        code: 'INVALID_FILE_TYPE'
      });
    }

    const processedFile = await processAndSaveImage(req.file, 'avatars', 256, 256);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        avatar: processedFile.fileUrl
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        email: true
      }
    });

    res.status(200).json({
      success: true,
      data: {
        user: updatedUser,
        fileSize: processedFile.fileSize,
        uploadedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Avatar upload error:', error);

    res.status(400).json({
      error: error.message || 'Avatar upload failed',
      code: 'UPLOAD_ERROR'
    });
  }
});

router.post('/message-attachment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file provided',
        code: 'NO_FILE'
      });
    }

    const userId = req.userId;
    const { messageId } = req.body;

    await validateUserExists(userId);

    if (!messageId) {
      return res.status(400).json({
        error: 'Message ID is required',
        code: 'MISSING_MESSAGE_ID'
      });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { senderId: true }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'MESSAGE_NOT_FOUND'
      });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({
        error: 'You can only upload files to your own messages',
        code: 'NOT_AUTHORIZED'
      });
    }

    let fileUrl, thumbnailUrl, fileName;
    const mimeType = req.file.mimetype;

    if (mimeType.startsWith('image/')) {
      const processedFile = await processAndSaveImage(req.file, 'messages', 2000, 2000);
      fileUrl = processedFile.fileUrl;
      thumbnailUrl = processedFile.fileUrl;
      fileName = processedFile.fileName;
    } else {
      fileName = `${uuidv4()}${path.extname(req.file.originalname)}`;
      const filePath = path.join(uploadDir, 'messages', fileName);
      await fs.writeFile(filePath, req.file.buffer);
      fileUrl = `${process.env.FRONTEND_URL}/uploads/messages/${fileName}`;
      thumbnailUrl = null;
    }

    const attachment = await prisma.attachment.create({
      data: {
        messageId,
        uploadedBy: userId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType: path.extname(req.file.originalname).substring(1) || 'unknown',
        fileUrl,
        thumbnailUrl,
        mimeType
      }
    });

    res.status(201).json({
      success: true,
      data: {
        attachment,
        uploadedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('File upload error:', error);

    res.status(400).json({
      error: error.message || 'File upload failed',
      code: 'UPLOAD_ERROR'
    });
  }
});

router.post('/message-attachments', upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No files provided',
        code: 'NO_FILES'
      });
    }

    const userId = req.userId;
    const { messageId } = req.body;

    await validateUserExists(userId);

    if (!messageId) {
      return res.status(400).json({
        error: 'Message ID is required',
        code: 'MISSING_MESSAGE_ID'
      });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { senderId: true }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'MESSAGE_NOT_FOUND'
      });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({
        error: 'You can only upload files to your own messages',
        code: 'NOT_AUTHORIZED'
      });
    }

    const attachments = [];

    for (const file of req.files) {
      try {
        let fileUrl, thumbnailUrl, fileName;
        const mimeType = file.mimetype;

        if (mimeType.startsWith('image/')) {
          const processedFile = await processAndSaveImage(file, 'messages', 2000, 2000);
          fileUrl = processedFile.fileUrl;
          thumbnailUrl = processedFile.fileUrl;
          fileName = processedFile.fileName;
        } else {
          fileName = `${uuidv4()}${path.extname(file.originalname)}`;
          const filePath = path.join(uploadDir, 'messages', fileName);
          await fs.writeFile(filePath, file.buffer);
          fileUrl = `${process.env.FRONTEND_URL}/uploads/messages/${fileName}`;
          thumbnailUrl = null;
        }

        const attachment = await prisma.attachment.create({
          data: {
            messageId,
            uploadedBy: userId,
            fileName: file.originalname,
            fileSize: file.size,
            fileType: path.extname(file.originalname).substring(1) || 'unknown',
            fileUrl,
            thumbnailUrl,
            mimeType
          }
        });

        attachments.push(attachment);
      } catch (fileError) {
        console.error(`Error processing file ${file.originalname}:`, fileError);
      }
    }

    res.status(201).json({
      success: true,
      data: {
        attachments,
        count: attachments.length,
        uploadedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Multiple file upload error:', error);

    res.status(400).json({
      error: error.message || 'File upload failed',
      code: 'UPLOAD_ERROR'
    });
  }
});

router.delete('/attachment/:attachmentId', async (req, res) => {
  try {
    const userId = req.userId;
    const { attachmentId } = req.params;

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId }
    });

    if (!attachment) {
      return res.status(404).json({
        error: 'Attachment not found',
        code: 'NOT_FOUND'
      });
    }

    if (attachment.uploadedBy !== userId) {
      return res.status(403).json({
        error: 'You can only delete your own attachments',
        code: 'NOT_AUTHORIZED'
      });
    }

    const fileName = attachment.fileUrl.split('/').pop();
    const fileType = attachment.fileUrl.includes('/avatars/') ? 'avatars' : 'messages';
    const filePath = path.join(uploadDir, fileType, fileName);

    try {
      await fs.unlink(filePath);
    } catch (unlinkError) {
      console.error('File deletion error:', unlinkError);
    }

    await prisma.attachment.delete({
      where: { id: attachmentId }
    });

    res.status(200).json({
      success: true,
      message: 'Attachment deleted successfully'
    });
  } catch (error) {
    console.error('Attachment deletion error:', error);

    res.status(500).json({
      error: error.message || 'Deletion failed',
      code: 'DELETE_ERROR'
    });
  }
});

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File size exceeds maximum allowed',
        code: 'FILE_TOO_LARGE'
      });
    }

    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Too many files uploaded',
        code: 'TOO_MANY_FILES'
      });
    }

    return res.status(400).json({
      error: error.message,
      code: 'MULTER_ERROR'
    });
  }

  if (error) {
    return res.status(400).json({
      error: error.message || 'Upload error',
      code: 'UPLOAD_ERROR'
    });
  }

  next();
});

export default router;
