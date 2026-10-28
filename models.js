// models.js - MongoDB (Mongoose) schemas for AI Interview Coach
import mongoose from 'mongoose';

const { Schema, model } = mongoose;

export const CATEGORIES = ['technical', 'hr', 'behavioral'];
export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

/* ------------------------------------------------------------------ */
/* User                                                                */
/* ------------------------------------------------------------------ */
const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [60, 'Name must be at most 60 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true, // creates a unique index -> duplicate emails are rejected by MongoDB
      lowercase: true,
      trim: true,
      maxlength: 120,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Invalid email address'],
    },
    // select:false -> the hash is never returned unless a query asks for it explicitly
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true, // adds createdAt + updatedAt
    toJSON: {
      // Safety net: even if the hash was loaded, it is stripped from API output.
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/* ------------------------------------------------------------------ */
/* Interview session                                                   */
/* ------------------------------------------------------------------ */
// One entry per question: what was asked, what the user typed, and the evaluation.
const itemSchema = new Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, default: '', maxlength: 3000 },
    score: { type: Number, min: 0, max: 100, default: 0 },
    strengths: [String],
    improvements: [String],
  },
  { _id: false }
);

const interviewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: CATEGORIES, required: true },
    difficulty: { type: String, enum: DIFFICULTIES, required: true },
    items: {
      type: [itemSchema],
      validate: [(v) => v.length > 0, 'At least one question is required'],
    },
    // Overall feedback for the whole session
    feedback: {
      engine: String, // e.g. "rule-based"
      engineLabel: String, // human readable label shown in the UI
      summary: String,
      strengths: [String],
      improvements: [String],
    },
    score: { type: Number, min: 0, max: 100, required: true },
  },
  { timestamps: true }
);

interviewSchema.index({ userId: 1, createdAt: -1 });

export const User = mongoose.models.User || model('User', userSchema);
export const Interview = mongoose.models.Interview || model('Interview', interviewSchema);
