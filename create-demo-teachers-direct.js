// Direct DynamoDB teacher insertion script for testing
require('dotenv').config();
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'us-east-1';
const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || 'Users';

const ddbClient = new DynamoDBClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const ddb = DynamoDBDocumentClient.from(ddbClient);

async function createDemoTeachers() {
  console.log('Creating demo teachers directly in DynamoDB...');
  
  const teachers = [
    {
      userId: 'TEACH001',
      name: 'Dr. Sarah Johnson',
      email: 'sarah.johnson@university.edu',
      password: 'password123',
      role: 'teacher',
      department: 'Computer Science',
      specialization: 'Machine Learning',
      employeeId: 'EMP001',
      approved: true,
      createdAt: new Date().toISOString()
    },
    {
      userId: 'TEACH002',
      name: 'Prof. Michael Chen',
      email: 'michael.chen@university.edu',
      password: 'password123',
      role: 'teacher',
      department: 'Mathematics',
      specialization: 'Statistics',
      employeeId: 'EMP002',
      approved: true,
      createdAt: new Date().toISOString()
    },
    {
      userId: 'TEACH003',
      name: 'Dr. Emily Rodriguez',
      email: 'emily.rodriguez@university.edu',
      password: 'password123',
      role: 'teacher',
      department: 'Physics',
      specialization: 'Quantum Mechanics',
      employeeId: 'EMP003',
      approved: true,
      createdAt: new Date().toISOString()
    },
    {
      userId: 'TEACH004',
      name: 'Prof. David Wilson',
      email: 'david.wilson@university.edu',
      password: 'password123',
      role: 'teacher',
      department: 'Chemistry',
      specialization: 'Organic Chemistry',
      employeeId: 'EMP004',
      approved: true,
      createdAt: new Date().toISOString()
    },
    {
      userId: 'TEACH005',
      name: 'Dr. Lisa Thompson',
      email: 'lisa.thompson@university.edu',
      password: 'password123',
      role: 'teacher',
      department: 'Biology',
      specialization: 'Molecular Biology',
      employeeId: 'EMP005',
      approved: true,
      createdAt: new Date().toISOString()
    }
  ];

  for (const teacher of teachers) {
    try {
      await ddb.send(new PutCommand({ 
        TableName: USERS_TABLE, 
        Item: teacher,
        ConditionExpression: 'attribute_not_exists(userId)' // Only create if doesn't exist
      }));
      console.log(`✅ Created teacher: ${teacher.name} (${teacher.userId})`);
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') {
        console.log(`⚠️  Teacher already exists: ${teacher.name} (${teacher.userId})`);
      } else {
        console.log(`❌ Error creating teacher ${teacher.name}: ${error.message}`);
      }
    }
  }

  console.log('\n🎉 Demo teacher creation completed!');
  console.log('\n📋 Test Login Credentials:');
  console.log('Teacher ID: TEACH001, Password: password123');
  console.log('Teacher ID: TEACH002, Password: password123');
  console.log('Teacher ID: TEACH003, Password: password123');
  console.log('Teacher ID: TEACH004, Password: password123');
  console.log('Teacher ID: TEACH005, Password: password123');
  console.log('\n🔧 Next Steps:');
  console.log('1. Go to Teacher Dashboard and test login with any of the above credentials');
  console.log('2. Go to Admin Panel → User Management to see all teachers');
  console.log('3. Go to Admin Panel → Teacher Assignment to assign teachers to classes');
  console.log('4. Go to Admin Panel → Timetable Management to create class schedules');
}

createDemoTeachers().catch(console.error);
