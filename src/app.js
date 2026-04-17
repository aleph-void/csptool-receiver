'use strict';

const express = require('express');
const path = require('path');

const JSON_TYPES = [
  'application/json',
  'application/csp-report',
  'application/reports+json',
];

function normalizeReport(report, contentType) {
  if (contentType && contentType.includes('application/reports+json')) {
    // Reporting API v1 (camelCase fields, blockedURL instead of blocked-uri)
    return {
      document_uri:        report.documentURL || null,
      referrer:            report.referrer || null,
      violated_directive:  report.violatedDirective || null,
      effective_directive: report.effectiveDirective || null,
      original_policy:     report.originalPolicy || null,
      blocked_uri:         report.blockedURL || null,
      status_code:         report.statusCode != null ? report.statusCode : null,
      source_file:         report.sourceFile || null,
      line_number:         report.lineNumber != null ? report.lineNumber : null,
      column_number:       report.columnNumber != null ? report.columnNumber : null,
      raw:                 JSON.stringify(report),
    };
  }
  // Legacy report-uri format (kebab-case fields)
  return {
    document_uri:        report['document-uri'] || null,
    referrer:            report['referrer'] || null,
    violated_directive:  report['violated-directive'] || null,
    effective_directive: report['effective-directive'] || null,
    original_policy:     report['original-policy'] || null,
    blocked_uri:         report['blocked-uri'] || null,
    status_code:         report['status-code'] != null ? report['status-code'] : null,
    source_file:         report['source-file'] || null,
    line_number:         report['line-number'] != null ? report['line-number'] : null,
    column_number:       report['column-number'] != null ? report['column-number'] : null,
    raw:                 JSON.stringify(report),
  };
}

function createApp(db) {
  const app = express();

  app.use(express.json({ type: JSON_TYPES }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/violations', (req, res) => {
    const contentType = req.get('content-type') || '';
    const body = req.body;

    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    let rawReports = [];

    if (contentType.includes('application/reports+json')) {
      // Reporting API: array of { type, age, url, userAgent, body }
      const items = Array.isArray(body) ? body : [body];
      rawReports = items
        .filter(item => item && item.type === 'csp-violation')
        .map(item => ({ report: item.body || item, contentType }));
    } else {
      // Legacy report-uri: { "csp-report": { ... } }
      const report = body['csp-report'] || body;
      rawReports = [{ report, contentType }];
    }

    for (const { report, contentType: ct } of rawReports) {
      if (!report || typeof report !== 'object') continue;
      const violation = normalizeReport(report, ct);
      const saved = db.insertViolation(violation);
      if (app.locals.io) {
        app.locals.io.emit('violation', saved);
      }
    }

    res.status(204).end();
  });

  app.get('/violations', (req, res) => {
    const { since } = req.query;
    const dateStr = since || new Date().toISOString().split('T')[0];
    const sinceISO = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00.000Z`;
    const violations = db.getViolationsSince(sinceISO);
    res.json(violations);
  });

  return app;
}

module.exports = { createApp, normalizeReport };
