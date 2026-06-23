/**
 * Vercel serverless entry — serves the Express API at /api/*
 */
import app from "../artifacts/api-server/dist/vercel.mjs";

export default app;
