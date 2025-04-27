const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
app.use(bodyParser.json());

const ADMIN_SECRET = 'SuperSecret123'; // 🔒 Admin password - change this to a secure one!

let authorizedUsers = [];
let debitAccounts = {};

// Load users and accounts from files
function loadDatabase() {
    const userLines = fs.readFileSync('./users.txt', 'utf-8').split('\n').filter(Boolean);
    authorizedUsers = userLines.map(line => {
        const [username, password] = line.trim().split(':');
        return { username, password };
    });

    const accountLines = fs.readFileSync('./accounts.txt', 'utf-8').split('\n').filter(Boolean);
    debitAccounts = {};
    accountLines.forEach(line => {
        const [acctNo, balance, owner] = line.trim().split('|');
        debitAccounts[acctNo] = { balance: parseFloat(balance), owner };
    });
}

// Save accounts back to file
function saveAccounts() {
    const data = Object.entries(debitAccounts)
        .map(([acctNo, { balance, owner }]) => `${acctNo}|${balance}|${owner}`)
        .join('\n');
    fs.writeFileSync('./accounts.txt', data);
}

// Save users back to file
function saveUsers() {
    const data = authorizedUsers
        .map(({ username, password }) => `${username}:${password}`)
        .join('\n');
    fs.writeFileSync('./users.txt', data);
}

// Helpers
function sendErrorResponse(res, statusCode, statusReason, message, moreInfo = "") {
    const errorResponse = {
        httpCode: statusCode.toString(),
        httpMessage: statusReason,
        moreInformation: message,
        ...(moreInfo && { moreDetails: moreInfo })
    };
    res.status(statusCode).json(errorResponse);
}

// Admin authentication middleware
function adminAuthMiddleware(req, res, next) {
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== ADMIN_SECRET) {
        return sendErrorResponse(res, 401, "Unauthorized", "Invalid or missing Admin Secret");
    }
    next();
}

// Admin APIs

// Add new user
app.post('/admin/add-user', adminAuthMiddleware, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return sendErrorResponse(res, 400, "Bad Request", "Username and Password are required.");
    }
    if (authorizedUsers.some(user => user.username === username)) {
        return sendErrorResponse(res, 400, "Bad Request", "User already exists.");
    }

    authorizedUsers.push({ username, password });
    saveUsers();
    res.json({ message: "User added successfully." });
});

// Add new account
app.post('/admin/add-account', adminAuthMiddleware, (req, res) => {
    const { acctNo, balance, owner } = req.body;
    if (!acctNo || balance == null || !owner) {
        return sendErrorResponse(res, 400, "Bad Request", "Account No, Balance, and Owner are required.");
    }
    if (debitAccounts[acctNo]) {
        return sendErrorResponse(res, 400, "Bad Request", "Account already exists.");
    }

    debitAccounts[acctNo] = { balance: parseFloat(balance), owner };
    saveAccounts();
    res.json({ message: "Account added successfully." });
});

// View all users and accounts status
app.get('/admin/status', adminAuthMiddleware, (req, res) => {
    res.json({
        users: authorizedUsers,
        accounts: debitAccounts
    });
});

// Your existing /single-payment API remains the same
// (I can re-add it if you want — looks like you already have it complete)


// Start server
loadDatabase();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
