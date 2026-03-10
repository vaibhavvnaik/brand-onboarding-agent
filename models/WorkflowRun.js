const mongoose = require('mongoose');

const WorkflowRunSchema = new mongoose.Schema(
  {
    step: {
      type: String,
      enum: [
        'discover_and_signup',
        'scan_inbox',
        'process_confirmations',
        'ingest_newsletters',
        'run_simplified_cycle'
      ],
      required: true
    },
    trigger: {
      type: String,
      enum: ['api', 'cli', 'scheduler'],
      default: 'api'
    },
    status: {
      type: String,
      enum: ['running', 'success', 'failed'],
      default: 'running'
    },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
    durationMs: Number,
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    error: String,
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

WorkflowRunSchema.index({ step: 1, startedAt: -1 });
WorkflowRunSchema.index({ startedAt: -1 });

module.exports = mongoose.model('WorkflowRun', WorkflowRunSchema);
