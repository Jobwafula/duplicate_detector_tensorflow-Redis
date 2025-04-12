// src/server.js
const createApp = require('./app');
const { initializeFile } = require('./services/fileService');
const { QUESTIONS_FILE } = require('./config/config');

const startServer = async () => {
    try {
        await initializeFile(QUESTIONS_FILE);
        const app = createApp();
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Server startup failed:', err);
        process.exit(1);
    }
};

startServer();