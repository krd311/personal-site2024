const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient, PutItemCommand, GetItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
require('dotenv').config();

const app = express();
app.use(express.static('public')); 

// AWS S3 Client Configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// AWS DynamoDB Client Configuration
const dbClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Set up multer to use S3 for storage
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    metadata: (req, file, cb) => {
      cb(null, {
        title: req.body.title || '',
        description: req.body.description || '',
        tags: req.body.tags || '',
        uploadTime: new Date().toISOString() // Add upload time to metadata
      });
    },
    key: (req, file, cb) => {
      cb(null, Date.now().toString() + '-' + file.originalname);
    },
    acl: 'public-read' // Ensure proper permissions
  }),
});

// Store metadata in DynamoDB
const storeMetadata = async (s3Key, title, description, tags, uploadTime) => {
  await dbClient.send(new PutItemCommand({
    TableName: 'image_info',
    Item: {
      s3Key: { S: s3Key },
      Title: { S: title },
      Description: { S: description },
      Tags: { SS: tags }, // Tags as a set of strings
      UploadTime: { S: uploadTime } // Store the upload time
    }
  }));
};

// Retrieve metadata from DynamoDB
const getMetadata = async (s3Key) => {
  try {
    console.log(s3Key)
    const result = await dbClient.send(new GetItemCommand({
      TableName: 'image_info',
      Key: {
        s3Key: { S: s3Key } // Ensure this matches your DynamoDB schema
      }
    }));

    // Check if the item exists and return it
    if (!result.Item) {
      return null;
    }
    
    return {
      Title: result.Item.Title ? result.Item.Title.S : '',
      Description: result.Item.Description ? result.Item.Description.S : '',
      Tags: result.Item.Tags ? result.Item.Tags.SS : [],
      UploadTime: result.Item.UploadTime ? result.Item.UploadTime.S : ''
    };
  } catch (err) {
    console.error(`Error fetching metadata for key ${s3Key}:`, err);
    return null;
  }
};

// List all metadata from DynamoDB
const listAllMetadata = async () => {
  const result = await dbClient.send(new ScanCommand({ TableName: 'image_info' }));
  return result.Items.map(item => ({
    s3Key: item.s3Key.S,
    title: item.Title.S,
    description: item.Description.S,
    tags: item.Tags.SS,
    uploadTime: item.UploadTime.S // Include upload time
  }));
};

// Single image upload route with additional form fields
app.post('/upload/single', upload.single('image'), async (req, res) => {
  const s3Key = req.file.key;
  const title = req.body.title;
  const description = req.body.description;
  const tags = req.body.tags ? req.body.tags.split(',') : [];
  const uploadTime = new Date().toISOString(); // Capture the upload time

  // Store metadata in DynamoDB
  await storeMetadata(s3Key, title, description, tags, uploadTime);

  res.json({
    imageUrl: req.file.location,
    title,
    description,
    tags,
    uploadTime
  });
});

// Multiple image upload route with additional form fields
app.post('/upload/multiple', upload.array('images', 10), async (req, res) => {
  try {
    const uploadTime = new Date().toISOString(); // Capture the upload time for all images
    const promises = req.files.map(async (file) => {
      const s3Key = file.key;
      const title = req.body.title || '';
      const description = req.body.description || '';
      const tags = req.body.tags ? req.body.tags.split(',') : [];

      // Store metadata in DynamoDB
      await storeMetadata(s3Key, title, description, tags, uploadTime);

      return {
        imageUrl: file.location,
        title,
        description,
        tags,
        uploadTime
      };
    });

    const results = await Promise.all(promises);

    res.json(results);
  } catch (err) {
    console.error('Error uploading multiple images:', err);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

// Route to list all images and their metadata
app.get('/images', async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
    });
    const data = await s3Client.send(command);

    const imageKeys = data.Contents.map((item) => item.Key);

    // Fetch metadata for each image
    const metadataPromises = imageKeys.map(async (key) => {
      const metadata = await getMetadata(key);
      return {
        key,
        url: `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${key}`,
        metadata: {
          title: metadata?.Title || '',
          description: metadata?.Description || '',
          tags: metadata?.Tags || [],
          uploadTime: metadata?.UploadTime || '' // Include upload time
        }
      };
    });

    const images = await Promise.all(metadataPromises);

    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve images' });
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
