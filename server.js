const express = require('express');
const tf = require('@tensorflow/tfjs-node');
const use = require('@tensorflow-models/universal-sentence-encoder');
const redis = require('redis');

const app = express();
app.use(express.json());

// Initialize components
let model;
let redisClient;

async function initialize() {
  console.log("Loading TensorFlow model...");
  model = await use.load();
  
  console.log("Connecting to Redis...");
  redisClient = redis.createClient();
  await redisClient.connect();
  
  console.log("System ready!");
}

initialize();


async function compareQuestions(question1, question2) {
    // Generate embeddings (numerical representations)
    const embeddings = await model.embed([question1, question2]);
    
    // Calculate cosine similarity
    const similarity = tf.matMul(
      embeddings.slice([0,0], [1]), 
      embeddings.slice([1,0], [1]).transpose()
    ).dataSync()[0];
    
    return similarity;
  }

app.post('/check', async (req, res) => {
  try {
    const { question1, question2 } = req.body;
    const similarity = await compareQuestions(question1, question2);
    res.json({ similarity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});