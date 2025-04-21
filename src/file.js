// server.js
const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors("*"));
const port = 3000;

// Use multer with memoryStorage
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  try {
    // Parse the Excel file from buffer
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // Check for duplicate questions
    const seen = new Set();
    const unique = [];
    let hasDuplicates = false;

    data.forEach((row) => {
      const question = row["Question Text"]?.trim();
      if (question) {
        if (seen.has(question.toLowerCase())) {
          hasDuplicates = true;
        } else {
          seen.add(question.toLowerCase());
          unique.push(row);
        }
      }
    });

    if (hasDuplicates) {
      const newWorkbook = xlsx.utils.book_new();
      const newSheet = xlsx.utils.json_to_sheet(unique);
      xlsx.utils.book_append_sheet(newWorkbook, newSheet, "Filtered");

      const buffer = xlsx.write(newWorkbook, {
        type: "buffer",
        bookType: "xlsx",
      });

      res.setHeader(
        "Content-Disposition",
        "attachment; filename=filtered_questions.xlsx"
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      return res.send(buffer);
    } else {
      return res.status(200).send("No duplicates found");
    }
  } catch (err) {
    console.error(err);
    return res.status(500).send("Error processing file, Upload an excel file");
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
