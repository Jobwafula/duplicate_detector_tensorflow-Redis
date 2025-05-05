const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const stringSimilarity = require("string-similarity");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const MAX_QUESTIONS_PER_BATCH = 1000;
const SIMILARITY_THRESHOLD = 0.85;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const UPLOADS_DIR = path.join(__dirname, "Uploads");

// Ensure uploads directory exists
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

// JSON file path
const QUESTIONS_FILE = path.join(__dirname, "questions.json");

// Multer configuration for file uploads
const upload = multer({
  dest: UPLOADS_DIR,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files are allowed (.xls, .xlsx)"));
    }
  },
  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// Initialize JSON file
async function initialize() {
  try {
    await fs.access(QUESTIONS_FILE);
  } catch {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions: [] }));
  }
  console.log("System ready!");
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
async function processQuestions(questions, rowData = []) {
  if (!Array.isArray(questions)) {
    throw new Error("Input must be an array of questions");
  }

  const validQuestions = questions
    .filter((q) => typeof q === "string" && q.trim().length > 0);

  if (validQuestions.length === 0) {
    throw new Error("No valid questions provided");
  }

  const results = [];
  const newQuestions = [];
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
      mostSimilarQuestion: mostSimilar.similarity > 0.6 ? mostSimilar.question : null,
      similarityScore: mostSimilar.similarity,
      rowData: rowData[i] || {} // Include original row data
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

// Process Excel file - Improved to maintain original format
async function processExcelFile(filePath) {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON with header option to preserve all columns
    const data = xlsx.utils.sheet_to_json(worksheet, { header: "A", defval: "" });

    if (data.length === 0) {
      throw new Error("Excel file is empty");
    }

    // Find question column (case-insensitive)
    const questionColumnNames = ['question', 'question text', 'q', 'text'];
    let questionColumn = null;
    
    // Check first row for headers
    const firstRow = data[0];
    for (const [key, value] of Object.entries(firstRow)) {
      if (questionColumnNames.includes(String(value).toLowerCase().trim())) {
        questionColumn = key;
        break;
      }
    }

    if (!questionColumn) {
      throw new Error("No 'Question' column found in the Excel file. Ensure the file has a column labeled 'Question', 'Question Text', or similar.");
    }

    // Extract questions and row data
    const questions = [];
    const rowData = [];
    const originalRows = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const question = row[questionColumn];
      if (typeof question === "string" && question.trim().length > 0) {
        questions.push(question.trim());
        rowData.push(row);
        originalRows.push(data[i]);
      }
    }

    if (questions.length === 0) {
      throw new Error("No valid questions found in the Excel file");
    }

    let results;
    if (questions.length > MAX_QUESTIONS_PER_BATCH) {
      // Process in batches if file is too large
      const batchResults = [];
      for (let i = 0; i < questions.length; i += MAX_QUESTIONS_PER_BATCH) {
        const batchQuestions = questions.slice(i, i + MAX_QUESTIONS_PER_BATCH);
        const batchRowData = rowData.slice(i, i + MAX_QUESTIONS_PER_BATCH);
        const batchResultsPart = await processQuestions(batchQuestions, batchRowData);
        batchResults.push(...batchResultsPart);
      }
      results = batchResults;
    } else {
      results = await processQuestions(questions, rowData);
    }

    // Filter out duplicate rows and prepare new data
    const newData = [data[0]]; // Keep headers
    const uniqueResults = results.filter(result => !result.isDuplicate);
    
    uniqueResults.forEach(result => {
      const originalRowIndex = results.indexOf(result);
      if (originalRowIndex !== -1) {
        newData.push(data[originalRowIndex + 1]); // +1 because data[0] is header
      }
    });

    // Create new workbook with filtered data
    const newWorkbook = xlsx.utils.book_new();
    const newWorksheet = xlsx.utils.json_to_sheet(newData, { skipHeader: true });
    xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, "Unique Questions");

    // Generate cleaned file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const originalFilename = path.basename(filePath);
    const cleanedFilename = `cleaned_${timestamp}_${originalFilename}`;
    const cleanedFilePath = path.join(path.dirname(filePath), cleanedFilename);
    
    // Write the new file
    xlsx.writeFile(newWorkbook, cleanedFilePath);

    return {
      results,
      cleanedFilePath: cleanedFilename,
      stats: {
        totalQuestions: results.length,
        duplicatesFound: results.filter(r => r.isDuplicate).length,
        uniqueQuestions: uniqueResults.length
      }
    };
  } catch (err) {
    console.error("Excel processing error:", err);
    throw new Error(`Error processing Excel file: ${err.message}`);
  }
}

// API endpoint for batch processing
app.post("/check-batch", async (req, res) => {
  try {
    const { questions } = req.body;
    
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: "Questions array is required" });
    }

    const results = await processQuestions(questions);
    res.json({ 
      success: true,
      results,
      stats: {
        totalQuestions: questions.length,
        duplicatesFound: results.filter(r => r.isDuplicate).length
      }
    });
  } catch (error) {
    console.error("Error processing questions:", error);
    res.status(400).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});

// API endpoint for file uploads
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        error: "No file uploaded" 
      });
    }

    const startTime = Date.now();
    const { results, cleanedFilePath, stats } = await processExcelFile(req.file.path);

    // Clean up the original uploaded file
    await fs.unlink(req.file.path).catch(console.error);

    res.json({
      success: true,
      results,
      cleanedFilePath,
      stats: {
        ...stats,
        processingTime: `${(Date.now() - startTime) / 1000} seconds`
      }
    });

  } catch (error) {
    console.error("Error processing file:", error);
    if (req.file) {
      fs.unlink(req.file.path).catch(console.error);
    }
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});

// API endpoint for file downloads
app.get("/download/:filename", async (req, res) => {
  try {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    await fs.access(filePath);
    
    // Set appropriate headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.filename}`);
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    // Clean up after download completes
    fileStream.on('end', () => {
      fs.unlink(filePath).catch(console.error);
    });
    
  } catch (err) {
    console.error("Download error:", err);
    res.status(404).send("File not found");
  }
});

// API endpoint to reset questions JSON file
app.post("/reset-questions", async (req, res) => {
  try {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify({ questions: [] }, null, 2));
    res.json({ 
      success: true,
      message: "Questions database has been reset successfully"
    });
  } catch (error) {
    console.error("Error resetting questions file:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy",
    version: "1.0.0",
    uptime: process.uptime()
  });
});

// Initialize and start server
initialize().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    console.log(`Max questions per batch: ${MAX_QUESTIONS_PER_BATCH}`);
  });
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});