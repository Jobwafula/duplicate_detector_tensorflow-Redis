// src/services/questionService.js
const stringSimilarity = require('string-similarity');
const { MAX_QUESTIONS, SIMILARITY_THRESHOLD } = require('../config/config');
const { readQuestions, writeQuestions } = require('./fileService');

const processQuestions = async (questions, questionsFile) => {
    if (!Array.isArray(questions)) {
        throw new Error('Input must be an array of questions');
    }

    if (questions.length > MAX_QUESTIONS) {
        throw new Error(`Maximum ${MAX_QUESTIONS} questions allowed per request`);
    }

    const validQuestions = questions
        .filter((q) => typeof q === 'string' && q.trim().length > 0)
        .slice(0, MAX_QUESTIONS);

    if (validQuestions.length === 0) {
        throw new Error('No valid questions provided');
    }

    const results = [];
    const newQuestions = [];
    const existingQuestions = await readQuestions(questionsFile);

    for (let i = 0; i < validQuestions.length; i++) {
        const currentQuestion = validQuestions[i];
        let isDuplicate = false;
        let mostSimilar = { similarity: 0, question: '' };

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
        await writeQuestions(questionsFile, updatedQuestions);
    }

    return results;
};

module.exports = {
    processQuestions,
};