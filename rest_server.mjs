import * as path from 'node:path';
import * as url from 'node:url';
import fs from 'node:fs';

import express from 'express';
import sqlite3 from 'sqlite3';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const db_filename = path.join(__dirname, 'db', 'stpaul_crime.sqlite3');

// IMPORTANT: after `npm run build` rename dist -> docs
const docs_dir = path.join(__dirname, 'docs');
const port = 8000;

const app = express();
app.use(express.json());

/********************************************************************
 ***   DATABASE FUNCTIONS                                         ***
 ********************************************************************/
let db = new sqlite3.Database(db_filename, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    console.log('Error opening ' + path.basename(db_filename));
    console.log(err.message);
  } else {
    console.log('Now connected to ' + path.basename(db_filename));
  }
});

function dbSelect(query, params) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(query, params) {
  return new Promise((resolve, reject) => {
    db.run(query, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/********************************************************************
 ***   API ROUTES                                                 ***
 ********************************************************************/

// GET request handler for crime codes
app.get('/codes', async (req, res) => {
  try {
    let query = 'SELECT code, incident_type FROM Codes';
    let params = [];

    if (req.query.code) {
      let codes = req.query.code.split(',').map((c) => c.trim());
      let placeholders = codes.map(() => '?').join(',');
      query += ` WHERE code IN (${placeholders})`;
      params = codes;
    }

    query += ' ORDER BY code';

    let rows = await dbSelect(query, params);
    let result = rows.map((row) => ({ code: row.code, type: row.incident_type }));

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).type('txt').send('Error retrieving codes');
  }
});

// GET request handler for neighborhoods
app.get('/neighborhoods', async (req, res) => {
  try {
    let query = 'SELECT neighborhood_number, neighborhood_name FROM Neighborhoods';
    let params = [];

    if (req.query.id) {
      let ids = req.query.id.split(',').map((id) => id.trim());
      let placeholders = ids.map(() => '?').join(',');
      query += ` WHERE neighborhood_number IN (${placeholders})`;
      params = ids;
    }

    query += ' ORDER BY neighborhood_number';

    let rows = await dbSelect(query, params);
    let result = rows.map((row) => ({
      id: row.neighborhood_number,
      name: row.neighborhood_name
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).type('txt').send('Error retrieving neighborhoods');
  }
});

// GET request handler for crime incidents
app.get('/incidents', async (req, res) => {
  try {
    let query = `
      SELECT
        case_number,
        DATE(date_time) as date,
        TIME(date_time) as time,
        code,
        incident,
        police_grid,
        neighborhood_number,
        block
      FROM Incidents
    `;

    let whereClauses = [];
    let params = [];

    if (req.query.start_date) {
      whereClauses.push('date(date_time) >= ?');
      params.push(req.query.start_date);
    }

    if (req.query.end_date) {
      whereClauses.push('date(date_time) <= ?');
      params.push(req.query.end_date);
    }

    if (req.query.code) {
      let codes = req.query.code.split(',').map((c) => c.trim());
      let placeholders = codes.map(() => '?').join(',');
      whereClauses.push(`code IN (${placeholders})`);
      params.push(...codes);
    }

    if (req.query.grid) {
      let grids = req.query.grid.split(',').map((g) => g.trim());
      let placeholders = grids.map(() => '?').join(',');
      whereClauses.push(`police_grid IN (${placeholders})`);
      params.push(...grids);
    }

    if (req.query.neighborhood) {
      let neighborhoods = req.query.neighborhood.split(',').map((n) => n.trim());
      let placeholders = neighborhoods.map(() => '?').join(',');
      whereClauses.push(`neighborhood_number IN (${placeholders})`);
      params.push(...neighborhoods);
    }

    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }

    query += ' ORDER BY date_time DESC';

    let limit = req.query.limit ? parseInt(req.query.limit) : 1000;
    if (!Number.isFinite(limit) || limit <= 0) limit = 1000;
    query += ` LIMIT ${limit}`;

    let rows = await dbSelect(query, params);

    let result = rows.map((row) => ({
      case_number: row.case_number,
      date: row.date,
      time: row.time,
      code: row.code,
      incident: row.incident,
      police_grid: row.police_grid,
      neighborhood_number: row.neighborhood_number,
      block: row.block
    }));

    res.status(200).json(result);
  } catch (error) {
    console.error(error);
    res.status(500).type('txt').send('Error retrieving incidents');
  }
});

// PUT request handler for new crime incident
app.put('/new-incident', async (req, res) => {
  try {
    let checkQuery = 'SELECT case_number FROM Incidents WHERE case_number = ?';
    let existing = await dbSelect(checkQuery, [req.body.case_number]);

    if (existing.length > 0) {
      res.status(500).type('txt').send('Case number already exists');
      return;
    }

    let insertQuery = `
      INSERT INTO Incidents (case_number, date_time, code, incident, police_grid, neighborhood_number, block)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    // expects req.body.date like "YYYY-MM-DD" and req.body.time like "HH:MM:SS"
    let dateTime = `${req.body.date}T${req.body.time}`;

    let params = [
      req.body.case_number,
      dateTime,
      req.body.code,
      req.body.incident,
      req.body.police_grid,
      req.body.neighborhood_number,
      req.body.block
    ];

    await dbRun(insertQuery, params);
    res.status(200).type('txt').send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).type('txt').send('Error inserting incident');
  }
});

// DELETE request handler for crime incident
app.delete('/remove-incident', async (req, res) => {
  try {
    let checkQuery = 'SELECT case_number FROM Incidents WHERE case_number = ?';
    let existing = await dbSelect(checkQuery, [req.body.case_number]);

    if (existing.length === 0) {
      res.status(500).type('txt').send('Case number does not exist');
      return;
    }

    let deleteQuery = 'DELETE FROM Incidents WHERE case_number = ?';
    await dbRun(deleteQuery, [req.body.case_number]);

    res.status(200).type('txt').send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).type('txt').send('Error deleting incident');
  }
});

/********************************************************************
 ***   SERVE THE SPA (docs/)                                      ***
 ********************************************************************/

if (fs.existsSync(docs_dir)) {
  // Serve built Vue files (docs/)
  app.use(express.static(docs_dir));

  // SPA fallback: REGEX catch-all (avoids path-to-regexp crash)
  // IMPORTANT: keep this AFTER all API routes
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(docs_dir, 'index.html'));
  });
} else {
  // Helpful message if someone forgot to build
  app.get('/', (req, res) => {
    res
      .status(200)
      .type('txt')
      .send("SPA not built yet. Run: npm run build && rename dist -> docs");
  });
}

/********************************************************************
 ***   START SERVER                                               ***
 ********************************************************************/
app.listen(port, () => {
  console.log('Now listening on port ' + port);
});