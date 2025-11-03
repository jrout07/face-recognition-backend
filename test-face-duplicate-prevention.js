const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_BASE = 'http://localhost:5002';

// Create a simple test image (1x1 pixel PNG in base64)
const testImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function testDuplicateFacePrevention() {
  console.log('🧪 Testing Face Duplicate Prevention...\n');

  try {
    // Test 1: First registration should succeed
    console.log('Test 1: First registration attempt...');
    const firstRegistration = await axios.post(`${API_BASE}/auth/register`, {
      name: 'Test User 1',
      email: 'test1@example.com',
      role: 'student',
      imageBase64: testImageBase64
    });
    
    console.log('✅ First registration successful:', firstRegistration.data);
    console.log('User ID:', firstRegistration.data.userId);
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Test 2: Second registration with same face should fail
    console.log('\nTest 2: Second registration attempt with same face...');
    try {
      const secondRegistration = await axios.post(`${API_BASE}/auth/register`, {
        name: 'Test User 2 (Different Name)',
        email: 'test2@example.com',
        role: 'teacher',
        imageBase64: testImageBase64
      });
      
      console.log('❌ ERROR: Second registration should have failed but succeeded:', secondRegistration.data);
    } catch (error) {
      if (error.response?.status === 409 && error.response?.data?.code === 'DUPLICATE_FACE') {
        console.log('✅ Duplicate face correctly detected and rejected!');
        console.log('Error message:', error.response.data.error);
      } else {
        console.log('❌ Unexpected error:', error.response?.data || error.message);
      }
    }
    
    // Test 3: Approve the first user to add them to Rekognition collection
    console.log('\nTest 3: Approving first user to add face to collection...');
    try {
      const approvalResponse = await axios.post(`${API_BASE}/admin/approve`, {
        userId: firstRegistration.data.userId,
        password: 'testpassword123'
      });
      console.log('✅ User approved and face indexed:', approvalResponse.data);
    } catch (error) {
      console.log('⚠️ Approval failed (expected if AWS not configured):', error.response?.data?.error || error.message);
    }
    
    // Test 4: Try registering again after approval (should still fail)
    console.log('\nTest 4: Registration attempt after face is in collection...');
    try {
      const thirdRegistration = await axios.post(`${API_BASE}/auth/register`, {
        name: 'Test User 3 (After Approval)',
        email: 'test3@example.com',
        role: 'student',
        imageBase64: testImageBase64
      });
      
      console.log('❌ ERROR: Third registration should have failed but succeeded:', thirdRegistration.data);
    } catch (error) {
      if (error.response?.status === 409 && error.response?.data?.code === 'DUPLICATE_FACE') {
        console.log('✅ Duplicate face correctly detected and rejected (post-approval)!');
        console.log('Error message:', error.response.data.error);
      } else {
        console.log('⚠️ Different error (might be AWS configuration):', error.response?.data || error.message);
      }
    }
    
    console.log('\n🎉 Face duplicate prevention testing completed!');
    
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the test
testDuplicateFacePrevention();
