require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { RekognitionClient, IndexFacesCommand, SearchFacesByImageCommand, CreateCollectionCommand } = require('@aws-sdk/client-rekognition');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/*
  Backend single-file implementation for local testing.
  EDIT .env with your AWS credentials and table/bucket names before running.
*/

const REGION = process.env.AWS_REGION || 'us-east-1';

const ddbClient = new DynamoDBClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const rekognition = new RekognitionClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';
const SESSIONS_TABLE = process.env.DYNAMODB_SESSIONS_TABLE || 'AttendanceSessions';
const ATTENDANCE_TABLE = process.env.DYNAMODB_ATTENDANCE_TABLE || 'Attendance';
const TIMETABLE_TABLE = process.env.DYNAMODB_TIMETABLE_TABLE || 'Timetable';
const S3_BUCKET = process.env.S3_BUCKET || 'face-recognition-users';
const REKOG_COLLECTION = process.env.REKOGNITION_COLLECTION_ID || 'attendance-users';
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 75);

/* --------- Helpers --------- */
async function createCollectionIfNotExists() {
  try {
    await rekognition.send(new CreateCollectionCommand({ CollectionId: REKOG_COLLECTION }));
    console.log('Rekognition collection created:', REKOG_COLLECTION);
  } catch (err) {
    if (err.name === 'ResourceAlreadyExistsException') {
      console.log('Rekognition collection already exists');
    } else {
      console.error('Create collection error (non-fatal):', err.message);
    }
  }
}

async function createTablesIfNotExist() {
  const tables = [
    {
      TableName: USERS_TABLE,
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST'
    },
    {
      TableName: SESSIONS_TABLE,
      KeySchema: [{ AttributeName: 'sessionId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'sessionId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST'
    },
    {
      TableName: ATTENDANCE_TABLE,
      KeySchema: [{ AttributeName: 'attendanceId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'attendanceId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST'
    },
    {
      TableName: TIMETABLE_TABLE,
      KeySchema: [{ AttributeName: 'timetableId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'timetableId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST'
    }
  ];

  for (const tableConfig of tables) {
    try {
      await ddbClient.send(new DescribeTableCommand({ TableName: tableConfig.TableName }));
      console.log(`Table ${tableConfig.TableName} already exists`);
    } catch (err) {
      if (err.name === 'ResourceNotFoundException') {
        try {
          await ddbClient.send(new CreateTableCommand(tableConfig));
          console.log(`Table ${tableConfig.TableName} created successfully`);
        } catch (createErr) {
          console.error(`Error creating table ${tableConfig.TableName}:`, createErr.message);
        }
      } else {
        console.error(`Error checking table ${tableConfig.TableName}:`, err.message);
      }
    }
  }
}

async function uploadToS3(key, buffer) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg'
  }));
  return `s3://${S3_BUCKET}/${key}`;
}

/* --------- Routes --------- */

app.get('/', (req, res) => res.send('Face Recognition Attendance Backend'));

/* ---------- Registration (live capture) ----------
Stores a pending user entry in DynamoDB with base64 image.
Admin will approve and index face in Rekognition.
*/
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, role, imageBase64 } = req.body;
    if (!name || !email || !role || !imageBase64) return res.status(400).json({ success:false, error:'Missing fields' });
    
    // Convert base64 image to buffer for face detection
    const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64');
    
    // Check for duplicate faces in the Rekognition collection
    try {
      const searchResponse = await rekognition.send(new SearchFacesByImageCommand({
        CollectionId: REKOG_COLLECTION,
        Image: { Bytes: imageBuffer },
        MaxFaces: 1,
        FaceMatchThreshold: 80 // 80% similarity threshold - adjust as needed
      }));
      
      if (searchResponse.FaceMatches && searchResponse.FaceMatches.length > 0) {
        const match = searchResponse.FaceMatches[0];
        const existingUserId = match.Face.ExternalImageId;
        
        // Get user details for better error message
        try {
          const existingUserResp = await ddb.send(new GetCommand({ 
            TableName: USERS_TABLE, 
            Key: { userId: existingUserId } 
          }));
          const existingUser = existingUserResp.Item;
          
          return res.status(409).json({ 
            success: false, 
            error: `This face is already registered to another user: ${existingUser?.name || existingUserId}. Each person can only register once.`,
            code: 'DUPLICATE_FACE'
          });
        } catch (userLookupErr) {
          return res.status(409).json({ 
            success: false, 
            error: 'This face is already registered to another user. Each person can only register once.',
            code: 'DUPLICATE_FACE'
          });
        }
      }
    } catch (searchErr) {
      // If collection doesn't exist or other search errors, log but continue registration
      if (searchErr.name !== 'ResourceNotFoundException') {
        console.warn('Face search error during registration:', searchErr.message);
      }
    }
    
    // Generate numeric-only ID based on role
    const rolePrefix = role === 'student' ? '1' : '2'; // 1 for students, 2 for teachers
    const timestamp = Date.now().toString().slice(-8); // Last 8 digits of timestamp
    const randomSuffix = Math.floor(Math.random() * 100).toString().padStart(2, '0'); // 2 random digits
    const tempId = rolePrefix + timestamp + randomSuffix; // Results in 11-digit numeric ID
    
    const item = { userId: tempId, name, email, role, approved: false, faceImage: imageBase64 };
    await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
    return res.json({ success:true, message: 'Registration submitted', userId: tempId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Admin: list pending users ---------- */
app.get('/admin/pending', async (req, res) => {
  try {
    const data = await ddb.send(new ScanCommand({ TableName: USERS_TABLE, FilterExpression: 'approved = :a', ExpressionAttributeValues: { ':a': false } }));
    res.json({ success:true, pending: data.Items || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Admin: approve user (indexes face in Rekognition, assigns password) ---------- */
app.post('/admin/approve', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) return res.status(400).json({ success:false, error:'userId and password required' });

    const userResp = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
    const user = userResp.Item;
    if (!user) return res.status(404).json({ success:false, error:'User not found' });
    if (!user.faceImage) return res.status(400).json({ success:false, error:'No face image for user' });

    // index face in Rekognition (from bytes)
    const imageBuffer = Buffer.from(user.faceImage.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64');

    // upload to S3 for persistence
    const key = `${userId}.jpg`;
    await uploadToS3(key, imageBuffer);

    // Index face
    const indexResp = await rekognition.send(new IndexFacesCommand({
      CollectionId: REKOG_COLLECTION,
      Image: { Bytes: imageBuffer },
      ExternalImageId: userId,
      DetectionAttributes: ['DEFAULT']
    }));

    const faceId = indexResp.FaceRecords?.[0]?.Face?.FaceId || null;

    // Update user with all required fields including isActive
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET approved = :a, password = :p, faceId = :f, photoKey = :k, isActive = :active, approvedAt = :now',
      ExpressionAttributeValues: { 
        ':a': true, 
        ':p': password, 
        ':f': faceId, 
        ':k': key,
        ':active': true,
        ':now': new Date().toISOString()
      }
    }));

    res.json({ success:true, message: 'User approved and face indexed', faceId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Admin: reject user ---------- */
app.post('/admin/reject', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required' });

    const userResp = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
    const user = userResp.Item;
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Update user as rejected
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET approved = :a, rejected = :r, rejectionReason = :reason, rejectedAt = :now',
      ExpressionAttributeValues: { 
        ':a': false, 
        ':r': true,
        ':reason': reason || 'No reason provided',
        ':now': new Date().toISOString()
      }
    }));

    res.json({ success: true, message: 'User registration rejected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Login ---------- */
app.post('/auth/login', async (req, res) => {
  try {
    const { userId, password, role } = req.body;
    if (!userId || !password || !role) return res.status(400).json({ success:false, error:'Missing fields' });
    const table = USERS_TABLE;
    const resp = await ddb.send(new GetCommand({ TableName: table, Key: { userId } }));
    const user = resp.Item;
    if (!user) return res.status(404).json({ success:false, error:'User not found' });
    if (!user.approved) return res.status(401).json({ success:false, error:'User not approved' });
    if (user.password !== password) return res.status(401).json({ success:false, error:'Incorrect password' });
    res.json({ success:true, message:'Login successful', userId, role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Verify Face (after login) ---------- */
app.post('/auth/verify-face', async (req, res) => {
  try {
    const { userId, imageBase64 } = req.body;
    if (!userId || !imageBase64) return res.status(400).json({ success:false, error:'Missing fields' });
    const resp = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
    const user = resp.Item;
    if (!user) return res.status(404).json({ success:false, error:'User not found' });

    const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64');
    const search = await rekognition.send(new SearchFacesByImageCommand({
      CollectionId: REKOG_COLLECTION,
      Image: { Bytes: imageBuffer },
      MaxFaces: 1,
      FaceMatchThreshold: FACE_MATCH_THRESHOLD
    }));

    const matched = search.FaceMatches?.find(f => f.Face.ExternalImageId === userId);
    if (matched) return res.json({ success:true, message:'Face matched', similarity: matched.Similarity });
    return res.json({ success:false, message:'Face not matched' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Admin: Create/Update Timetable ---------- */
app.post('/admin/timetable', async (req, res) => {
  try {
    const { classId, className, teacherId, teacherName, dayOfWeek, startTime, endTime, subject, room } = req.body;
    
    if (!classId || !className || !teacherId || !dayOfWeek || !startTime || !endTime || !subject) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const timetableId = `${classId}-${dayOfWeek}-${startTime}`;
    
    await ddb.send(new PutCommand({
      TableName: TIMETABLE_TABLE,
      Item: {
        timetableId,
        classId,
        className,
        teacherId,
        teacherName: teacherName || 'Unknown Teacher',
        dayOfWeek,
        startTime,
        endTime,
        subject,
        room: room || '',
        createdAt: new Date().toISOString(),
        isActive: true
      }
    }));

    res.json({ success: true, message: 'Timetable entry created/updated', timetableId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Get All Timetables ---------- */
app.get('/admin/timetables', async (req, res) => {
  try {
    const data = await ddb.send(new ScanCommand({ 
      TableName: TIMETABLE_TABLE,
      FilterExpression: 'isActive = :active',
      ExpressionAttributeValues: { ':active': true }
    }));
    
    res.json({ success: true, timetables: data.Items || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Delete Timetable Entry ---------- */
app.delete('/admin/timetable/:timetableId', async (req, res) => {
  try {
    const { timetableId } = req.params;
    
    await ddb.send(new UpdateCommand({
      TableName: TIMETABLE_TABLE,
      Key: { timetableId },
      UpdateExpression: 'SET isActive = :inactive',
      ExpressionAttributeValues: { ':inactive': false }
    }));

    res.json({ success: true, message: 'Timetable entry deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Student: Get My Classes Today ---------- */
app.get('/student/classes/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    
    // Get user's class assignments (you might need to modify this based on your user structure)
    const userData = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId }
    }));

    if (!userData.Item) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Get all timetables for today
    const data = await ddb.send(new ScanCommand({ 
      TableName: TIMETABLE_TABLE,
      FilterExpression: 'dayOfWeek = :day AND isActive = :active',
      ExpressionAttributeValues: { ':day': today, ':active': true }
    }));
    
    const classes = data.Items || [];
    
    // Sort by start time
    classes.sort((a, b) => a.startTime.localeCompare(b.startTime));
    
    res.json({ success: true, classes, today });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Teacher: Get My Classes Today ---------- */
app.get('/teacher/classes/:teacherId', async (req, res) => {
  try {
    const { teacherId } = req.params;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    
    const data = await ddb.send(new ScanCommand({ 
      TableName: TIMETABLE_TABLE,
      FilterExpression: 'teacherId = :tid AND dayOfWeek = :day AND isActive = :active',
      ExpressionAttributeValues: { ':tid': teacherId, ':day': today, ':active': true }
    }));
    
    const classes = data.Items || [];
    
    // Sort by start time
    classes.sort((a, b) => a.startTime.localeCompare(b.startTime));
    
    // Add current time check for attendance eligibility
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
    const enrichedClasses = classes.map(cls => ({
      ...cls,
      canTakeAttendance: currentTime >= cls.startTime && currentTime <= cls.endTime,
      isUpcoming: currentTime < cls.startTime,
      isCompleted: currentTime > cls.endTime
    }));
    
    res.json({ success: true, classes: enrichedClasses, today, currentTime });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Teacher: generate QR (dynamic, expire 10 min) ---------- */
app.post('/teacher/generate-qr', async (req, res) => {
  try {
    const { teacherId, classId } = req.body;
    if (!teacherId || !classId) return res.status(400).json({ success:false, error:'Missing fields' });
    const sessionId = `CLASS-${classId}-${Date.now()}`;
    const qrData = await QRCode.toDataURL(sessionId);
    const expireAt = Math.floor((Date.now() + 10*60*1000)/1000); // unix seconds

    await ddb.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: { sessionId, classId, teacherId, expireAt } }));
    res.json({ success:true, qrData, sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Student: mark attendance (face already verified) ---------- */
app.post('/attendance/mark', async (req, res) => {
  try {
    const { userId, sessionId } = req.body;
    if (!userId || !sessionId) return res.status(400).json({ success:false, error:'Missing fields' });

    const sessionResp = await ddb.send(new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }));
    const session = sessionResp.Item;
    if (!session) return res.json({ success:false, error:'Invalid session' });

    const now = Math.floor(Date.now()/1000);
    if (now > session.expireAt) return res.json({ success:false, error:'Session expired' });

    const today = new Date().toISOString().split('T')[0];

    await ddb.send(new PutCommand({ TableName: ATTENDANCE_TABLE, Item: { attendanceId: `${userId}-${sessionId}`, userId, sessionId, timestamp: new Date().toISOString(), date: today, status: 'Present' } }));

    res.json({ success:true, message:'Attendance marked' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* ---------- Get attendance by class (teacher) ---------- */
app.get('/teacher/attendance/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    
    // Get attendance records
    const attendanceData = await ddb.send(new ScanCommand({ 
      TableName: ATTENDANCE_TABLE, 
      FilterExpression: 'contains(sessionId, :c)', 
      ExpressionAttributeValues: { ':c': classId } 
    }));
    
    const attendance = attendanceData.Items || [];
    
    // Enrich attendance data with user information
    const enrichedAttendance = await Promise.all(
      attendance.map(async (record) => {
        try {
          // Get user details for each attendance record
          const userData = await ddb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { userId: record.userId }
          }));
          
          return {
            ...record,
            userName: userData.Item?.name || 'Unknown User',
            userEmail: userData.Item?.email || '',
            userRole: userData.Item?.role || 'student'
          };
        } catch (err) {
          console.error(`Error fetching user data for ${record.userId}:`, err);
          return {
            ...record,
            userName: 'Unknown User',
            userEmail: '',
            userRole: 'student'
          };
        }
      })
    );
    
    res.json({ success: true, attendance: enrichedAttendance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Get All Approved Users ---------- */
app.get('/admin/users', async (req, res) => {
  try {
    const data = await ddb.send(new ScanCommand({ 
      TableName: USERS_TABLE,
      FilterExpression: 'approved = :a AND (attribute_not_exists(isActive) OR isActive = :active)',
      ExpressionAttributeValues: { ':a': true, ':active': true }
    }));
    
    const users = data.Items || [];
    const students = users.filter(user => user.role === 'student');
    const teachers = users.filter(user => user.role === 'teacher');
    
    console.log(`Found ${users.length} approved users: ${students.length} students, ${teachers.length} teachers`);
    
    res.json({ 
      success: true, 
      users: {
        students,
        teachers,
        total: users.length
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Remove User ---------- */
app.delete('/admin/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // First get user details
    const userResp = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId } }));
    const user = userResp.Item;
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Remove user from DynamoDB
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET approved = :inactive, isActive = :inactive',
      ExpressionAttributeValues: { ':inactive': false }
    }));

    res.json({ success: true, message: `User ${userId} removed successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Assign Teacher to Class ---------- */
app.post('/admin/assign-teacher', async (req, res) => {
  try {
    const { timetableId, teacherId, teacherName } = req.body;
    
    if (!timetableId || !teacherId) {
      return res.status(400).json({ success: false, error: 'Timetable ID and Teacher ID are required' });
    }

    // Verify teacher exists
    const teacherResp = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { userId: teacherId } }));
    const teacher = teacherResp.Item;
    
    if (!teacher || teacher.role !== 'teacher') {
      return res.status(404).json({ success: false, error: 'Teacher not found or invalid role' });
    }

    // Update timetable with new teacher assignment
    await ddb.send(new UpdateCommand({
      TableName: TIMETABLE_TABLE,
      Key: { timetableId },
      UpdateExpression: 'SET teacherId = :tid, teacherName = :tname, assignedAt = :now',
      ExpressionAttributeValues: { 
        ':tid': teacherId, 
        ':tname': teacherName || teacher.name,
        ':now': new Date().toISOString()
      }
    }));

    res.json({ success: true, message: `Teacher ${teacherName || teacher.name} assigned to class successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Get Teacher Assignments ---------- */
app.get('/admin/teacher-assignments', async (req, res) => {
  try {
    // Get all timetables
    const timetableData = await ddb.send(new ScanCommand({ 
      TableName: TIMETABLE_TABLE,
      FilterExpression: 'isActive = :active',
      ExpressionAttributeValues: { ':active': true }
    }));

    // Get all teachers
    const teacherData = await ddb.send(new ScanCommand({ 
      TableName: USERS_TABLE,
      FilterExpression: '#role = :role AND approved = :approved',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'teacher', ':approved': true }
    }));

    const timetables = timetableData.Items || [];
    const teachers = teacherData.Items || [];

    // Group timetables by teacher
    const teacherAssignments = teachers.map(teacher => {
      const assignedClasses = timetables.filter(t => t.teacherId === teacher.userId);
      return {
        ...teacher,
        assignedClasses: assignedClasses.length,
        classes: assignedClasses
      };
    });

    res.json({ 
      success: true, 
      assignments: {
        teachers: teacherAssignments,
        unassignedClasses: timetables.filter(t => !t.teacherId || t.teacherId === ''),
        totalClasses: timetables.length
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Get Teachers Only ---------- */
app.get('/admin/teachers', async (req, res) => {
  try {
    const data = await ddb.send(new ScanCommand({ 
      TableName: USERS_TABLE,
      FilterExpression: 'approved = :a AND #role = :r AND (attribute_not_exists(isActive) OR isActive = :active)',
      ExpressionAttributeValues: { 
        ':a': true,
        ':r': 'teacher',
        ':active': true
      },
      ExpressionAttributeNames: {
        '#role': 'role'
      }
    }));
    
    const teachers = data.Items || [];
    console.log(`Found ${teachers.length} approved teachers`);
    
    res.json({ 
      success: true, 
      teachers: teachers.map(teacher => ({
        userId: teacher.userId,
        name: teacher.name,
        email: teacher.email,
        role: teacher.role,
        department: teacher.department || 'Not specified',
        specialization: teacher.specialization || 'Not specified',
        employeeId: teacher.employeeId || teacher.userId
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Admin: Get Classes with Teacher Info ---------- */
app.get('/admin/classes-with-teachers', async (req, res) => {
  try {
    const timetableData = await ddb.send(new ScanCommand({ 
      TableName: TIMETABLE_TABLE,
      FilterExpression: 'isActive = :active',
      ExpressionAttributeValues: { ':active': true }
    }));
    
    const timetables = timetableData.Items || [];
    
    // Get teacher info for assigned classes
    const classesWithTeachers = await Promise.all(
      timetables.map(async (timetable) => {
        if (timetable.teacherId) {
          try {
            const teacherResp = await ddb.send(new GetCommand({ 
              TableName: USERS_TABLE, 
              Key: { userId: timetable.teacherId } 
            }));
            return {
              ...timetable,
              teacher: teacherResp.Item ? {
                name: teacherResp.Item.name,
                department: teacherResp.Item.department,
                specialization: teacherResp.Item.specialization
              } : null
            };
          } catch (error) {
            return { ...timetable, teacher: null };
          }
        }
        return { ...timetable, teacher: null };
      })
    );
    
    res.json({ 
      success: true, 
      classes: classesWithTeachers
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Teacher: Get My Classes ---------- */
app.get('/teacher/my-classes/:teacherId', async (req, res) => {
  try {
    const { teacherId } = req.params;
    
    const data = await ddb.send(new ScanCommand({ 
      TableName: TIMETABLE_TABLE,
      FilterExpression: 'teacherId = :tid AND isActive = :active',
      ExpressionAttributeValues: { 
        ':tid': teacherId,
        ':active': true
      }
    }));
    
    const classes = data.Items || [];
    res.json({ 
      success: true, 
      classes: classes.sort((a, b) => {
        const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const dayA = dayOrder.indexOf(a.dayOfWeek);
        const dayB = dayOrder.indexOf(b.dayOfWeek);
        if (dayA !== dayB) return dayA - dayB;
        return a.startTime.localeCompare(b.startTime);
      })
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Teacher: Get All Students for Attendance ---------- */
app.get('/teacher/students/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    
    // Get all approved students
    const data = await ddb.send(new ScanCommand({ 
      TableName: USERS_TABLE,
      FilterExpression: 'approved = :a AND #role = :r AND (attribute_not_exists(isActive) OR isActive = :active)',
      ExpressionAttributeValues: { 
        ':a': true,
        ':r': 'student',
        ':active': true
      },
      ExpressionAttributeNames: {
        '#role': 'role'
      }
    }));
    
    const students = data.Items || [];
    
    // Get today's attendance for this class
    const today = new Date().toISOString().split('T')[0];
    const attendanceData = await ddb.send(new ScanCommand({ 
      TableName: ATTENDANCE_TABLE, 
      FilterExpression: 'contains(sessionId, :c) AND begins_with(#date, :today)', 
      ExpressionAttributeValues: { ':c': classId, ':today': today },
      ExpressionAttributeNames: { '#date': 'date' }
    }));
    
    const attendanceRecords = attendanceData.Items || [];
    const presentStudentIds = new Set(attendanceRecords.map(record => record.userId));
    
    // Combine student data with attendance status
    const studentsWithAttendance = students.map(student => ({
      ...student,
      isPresent: presentStudentIds.has(student.userId),
      attendanceMarked: presentStudentIds.has(student.userId)
    }));
    
    res.json({ 
      success: true, 
      students: studentsWithAttendance,
      classId,
      date: today
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Teacher: Manual Attendance Submission ---------- */
app.post('/teacher/submit-attendance', async (req, res) => {
  try {
    const { teacherId, classId, presentStudents, sessionId } = req.body;
    
    if (!teacherId || !classId || !Array.isArray(presentStudents)) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const today = new Date().toISOString().split('T')[0];
    const timestamp = new Date().toISOString();
    const finalSessionId = sessionId || `MANUAL-${classId}-${Date.now()}`;

    // Create attendance records for present students
    const attendancePromises = presentStudents.map(async (studentId) => {
      const attendanceId = `${studentId}-${finalSessionId}`;
      
      return ddb.send(new PutCommand({ 
        TableName: ATTENDANCE_TABLE, 
        Item: { 
          attendanceId,
          userId: studentId,
          sessionId: finalSessionId,
          timestamp,
          date: today,
          status: 'Present',
          markedBy: teacherId,
          method: 'manual'
        } 
      }));
    });

    await Promise.all(attendancePromises);

    res.json({ 
      success: true, 
      message: `Attendance marked for ${presentStudents.length} students`,
      presentCount: presentStudents.length,
      sessionId: finalSessionId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ---------- Student: QR Code Scanner with Back Camera Support ---------- */
app.post('/student/scan-qr', async (req, res) => {
  try {
    const { userId, qrData, cameraType } = req.body;
    
    if (!userId || !qrData) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    // Validate QR code format and session
    const sessionResp = await ddb.send(new GetCommand({ 
      TableName: SESSIONS_TABLE, 
      Key: { sessionId: qrData } 
    }));
    
    const session = sessionResp.Item;
    if (!session) {
      return res.json({ success: false, error: 'Invalid QR code' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > session.expireAt) {
      return res.json({ success: false, error: 'QR code has expired' });
    }

    // Mark attendance
    const today = new Date().toISOString().split('T')[0];
    const attendanceId = `${userId}-${qrData}`;
    
    await ddb.send(new PutCommand({ 
      TableName: ATTENDANCE_TABLE, 
      Item: { 
        attendanceId,
        userId,
        sessionId: qrData,
        timestamp: new Date().toISOString(),
        date: today,
        status: 'Present',
        method: 'qr_scan',
        cameraUsed: cameraType || 'unknown'
      } 
    }));

    res.json({ 
      success: true, 
      message: 'Attendance marked successfully via QR scan',
      classId: session.classId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* --------- init --------- */
const PORT = process.env.PORT || 5002;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await createCollectionIfNotExists();
  await createTablesIfNotExist();
});
