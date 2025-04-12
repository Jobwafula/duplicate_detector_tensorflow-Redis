// src/routes/questionRoutes.js
const express = require('express');
const { processQuestions } = require('../services/questionService');
const { QUESTIONS_FILE } = require('../config/config');

const router = express.Router();

router.post('/check-batch', async (req, res) => {
    try {
        const { questions } = req.body;
        const results = await processQuestions(questions, QUESTIONS_FILE);
        res.json({ results });
    } catch (error) {
        console.error('Error processing questions:', error);
        res.status(400).json({
            error: error.message,
            details: error.stack,
        });
    }
});

module.exports = router;