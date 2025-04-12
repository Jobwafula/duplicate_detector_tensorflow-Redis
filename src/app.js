// src/app.js
const express = require('express');
const questionRoutes = require('./routes/questionRoutes');

const createApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api', questionRoutes);
    return app;
};

module.exports = createApp;