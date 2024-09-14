const express = require('express');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient, PutItemCommand, GetItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const session = require('express-session');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session and Passport setup
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

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

// Passport local strategy for authentication
passport.use(new LocalStrategy(
  async (username, password, done) => {
    try {
      const result = await dbClient.send(new GetItemCommand({
        TableName: 'users',
        Key: { username: { S: username } }
      }));

      if (!result.Item || !(await bcrypt.compare(password, result.Item.password.S))) {
        return done(null, false, { message: 'Invalid username or password' });
      }

      return done(null, { username });
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => {
  done(null, user.username);
});

passport.deserializeUser(async (username, done) => {
  try {
    const result = await dbClient.send(new GetItemCommand({
      TableName: 'users',
      Key: { username: { S: username } }
    }));

    if (!result.Item) {
      return done(new Error('User not found'));
    }

    done(null, { username });
  } catch (err) {
    done(err);
  }
});

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

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
    const result = await dbClient.send(new GetItemCommand({
      TableName: 'image_info',
      Key: { s3Key: { S: s3Key } }
    }));

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
    uploadTime: item.UploadTime.S
  }));
};

// User Registration
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    await dbClient.send(new PutItemCommand({
      TableName: 'users',
      Item: {
        username: { S: username },
        password: { S: hashedPassword }
      }
    }));
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// User Login
app.post('/login', passport.authenticate('local'), (req, res) => {
  const token = jwt.sign({ username: req.user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

// Logout route
app.post('/logout', (req, res) => {
    req.logout((err) => {
      if (err) return next(err);
      res.redirect('/login.html');
    });
  });

// Single image upload route with additional form fields (authentication required)
app.post('/upload/single', isAuthenticated, upload.single('image'), async (req, res) => {
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
  

// Route to get user info
app.get('/user', (req, res) => {
    if (req.isAuthenticated()) {
      res.json({ username: req.user.username });
    } else {
      res.json({});
    }
  });
  
// I don't even know if this works right now.. ignore for now
// Multiple image upload route with additional form fields (authentication required)
app.post('/upload/multiple', isAuthenticated, upload.array('images', 10), async (req, res) => {
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
          uploadTime: metadata?.UploadTime || ''
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
