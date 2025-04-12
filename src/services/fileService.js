// src/services/fileService.js
const fs = require('fs').promises;
const path = require('path');

const initializeFile = async (filePath) => {
    try {
        // Check if file exists; if not, create it
        try {
            await fs.access(filePath);
        } catch {
            await fs.writeFile(filePath, JSON.stringify({ questions: [] }));
        }
        console.log('Questions file initialized');
    } catch (err) {
        console.error('File initialization failed:', err);
        throw err;
    }
};

const readQuestions = async (filePath) => {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data).questions || [];
    } catch (err) {
        console.error('Error reading questions file:', err);
        return [];
    }
};

const writeQuestions = async (filePath, questions) => {
    try {
        await fs.writeFile(filePath, JSON.stringify({ questions }, null, 2));
    } catch (err) {
        console.error('Error writing questions file:', err);
        throw err;
    }
};

module.exports = {
    initializeFile,
    readQuestions,
    writeQuestions,
};