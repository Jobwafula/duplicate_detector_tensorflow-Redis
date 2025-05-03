const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const stringSimilarity = require("string-similarity");
const cors = require("cors")

const app = express();
app.use(cors())
app.use(express.json());

// Configuration
const MAX_QUESTIONS = 5;
const SIMILARITY_THRESHOLD = 0.85;

// JSON file path
const QUESTIONS_FILE = path.join(__dirname, "questions.json");

// Initialize JSON file
async function initialize() {
  try {
    // Check if questions.json exists; if not, create it
    try {
      await fs.access(QUESTIONS_FILE);
    } catch {
      await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions: [] }));
    }
    console.log("System ready!");
  } catch (err) {
    console.error("Initialization failed:", err);
    process.exit(1);
  }
}

// Read questions from JSON file
async function getStoredQuestions() {
  try {
    const data = await fs.readFile(QUESTIONS_FILE, "utf8");
    return JSON.parse(data).questions || [];
  } catch (err) {
    console.error("Error reading questions file:", err);
    return [];
  }
}

// Write questions to JSON file
async function saveQuestions(questions) {
  try {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions }, null, 2));
  } catch (err) {
    console.error("Error writing questions file:", err);
  }
}

// Process multiple questions
async function processQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw new Error("Input must be an array of questions");
  }

  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`Maximum ${MAX_QUESTIONS} questions allowed per request`);
  }

  const validQuestions = questions
    .filter((q) => typeof q === "string" && q.trim().length > 0)
    .slice(0, MAX_QUESTIONS);

  if (validQuestions.length === 0) {
    throw new Error("No valid questions provided");
  }

  const results = [];
  const newQuestions = [];

  // Load existing questions
  const existingQuestions = await getStoredQuestions();

  for (let i = 0; i < validQuestions.length; i++) {
    const currentQuestion = validQuestions[i];
    let isDuplicate = false;
    let mostSimilar = { similarity: 0, question: "" };

    // Check against existing questions
    for (const existing of existingQuestions) {
      const similarity = stringSimilarity.compareTwoStrings(
        currentQuestion.toLowerCase(),
        existing.text.toLowerCase()
      );

      if (similarity > mostSimilar.similarity) {
        mostSimilar = { similarity, question: existing.text };
      }

      if (similarity > SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    // Check against other new questions in this batch
    if (!isDuplicate) {
      for (let j = 0; j < newQuestions.length; j++) {
        const similarity = stringSimilarity.compareTwoStrings(
          currentQuestion.toLowerCase(),
          newQuestions[j].text.toLowerCase()
        );

        if (similarity > mostSimilar.similarity) {
          mostSimilar = { similarity, question: newQuestions[j].text };
        }

        if (similarity > SIMILARITY_THRESHOLD) {
          isDuplicate = true;
          break;
        }
      }
    }

    results.push({
      question: currentQuestion,
      isDuplicate,
      mostSimilarQuestion:
        mostSimilar.similarity > 0.6 ? mostSimilar.question : null,
      similarityScore: mostSimilar.similarity,
    });

    if (!isDuplicate) {
      newQuestions.push({
        id: `question:${Date.now()}-${i}`,
        text: currentQuestion,
      });
    }
  }

  // Store new questions
  if (newQuestions.length > 0) {
    const updatedQuestions = [...existingQuestions, ...newQuestions];
    await saveQuestions(updatedQuestions);
  }

  return results;
}

// API endpoint
app.post("/check-batch", async (req, res) => {
  try {
    const { questions } = req.body;
    const results = await processQuestions(questions);
    res.json({ results });
  } catch (error) {
    console.error("Error processing questions:", error);
    res.status(400).json({
      error: error.message,
      details: error.stack,
    });
  }
});

// Initialize and start server
initialize().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
