const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const app = express();
app.use(bodyParser.json());

let authorizedUsers = [];
let debitAccounts = {};

// Helper to load users and accounts from files
function loadDatabase() {
    // Load users
    const userLines = fs.readFileSync('./users.txt', 'utf-8').split('\n').filter(Boolean);
    authorizedUsers = userLines.map(line => {
        const [username, password] = line.trim().split(':');
        return { username, password };
    });

    // Load accounts
    const accountLines = fs.readFileSync('./accounts.txt', 'utf-8').split('\n').filter(Boolean);
    debitAccounts = {};
    accountLines.forEach(line => {
        const [acctNo, balance, owner] = line.trim().split('|');
        debitAccounts[acctNo] = { balance: parseFloat(balance), owner };
    });
}

// Helper to save accounts back to file
function saveAccounts() {
    const data = Object.entries(debitAccounts)
        .map(([acctNo, { balance, owner }]) => `${acctNo}|${balance}|${owner}`)
        .join('\n');
    fs.writeFileSync('./accounts.txt', data);
}

// Helper Functions
function sendErrorResponse(res, statusCode, statusReason, message, moreInfo = "") {
    const errorResponse = {
        httpCode: statusCode.toString(),
        httpMessage: statusReason,
        moreInformation: message,
        ...(moreInfo && { moreDetails: moreInfo })
    };
    res.status(statusCode).json(errorResponse);
}

function sendErrorResponseCode(res, header, errorCode, errorDesc) {
    const errorResponse = {
        get_Single_Payment_Status_Corp_Res: {
            Header: {
                TranID: header.TranID || "",
                Corp_ID: header.Corp_ID || "",
                Maker_ID: header.Maker_ID || "",
                Checker_ID: header.Checker_ID || "",
                Approver_ID: header.Approver_ID || "",
                Status: "FAILED",
                Error_Cde: errorCode,
                Error_Desc: "Schema Validation Failure",
                Error_More_Desc: errorDesc
            },
            Signature: {
                Signature: "Signature"
            }
        }
    };
    res.status(200).json(errorResponse);
}

function generateRandomString(prefix, length) {
    const characters = '0123456789';
    let result = prefix;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function getISTDateTime() {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// Main API
app.post('/single-payment', (req, res) => {
    try {
        const contentType = req.headers['content-type'];
        if (!contentType || contentType.toLowerCase() !== 'application/json') {
            return sendErrorResponse(res, 415, "Unsupported Media Type", "Content-Type must be application/json");
        }

        const requestBodyJson = req.body;
        if (!requestBodyJson) {
            return sendErrorResponse(res, 400, "Bad Request", "Request Body is missing or empty");
        }

        const { Single_Payment_Corp_Req } = requestBodyJson || {};
        if (!Single_Payment_Corp_Req) {
            return sendErrorResponse(res, 400, "Bad Request", "'Single_Payment_Corp_Req' tag missing in Request Body");
        }

        const { Header, Body } = Single_Payment_Corp_Req;
        const alphanumericRegex = /^[A-Za-z0-9]+$/;
        const nonSpecialCharsRegex = /^[A-Za-z0-9\s]*$/;
        const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

        const requiredHeaderFieldsTra = ['TranID', 'Corp_ID'];
        for (const field of requiredHeaderFieldsTra) {
            if (!Header?.[field] || !alphanumericRegex.test(Header[field]) || Header[field].length > 16) {
                return sendErrorResponse(res, 401, "Unauthorized", `Authentication Failure: Invalid field ${field}`);
            }
        }

        const requiredHeaderFields = ['Maker_ID', 'Checker_ID', 'Approver_ID'];
        for (const field of requiredHeaderFields) {
            if (!Header?.[field] || !alphanumericRegex.test(Header[field]) || Header[field].length > 20) {
                return sendErrorResponseCode(res, Header, "ER002", `${field} must be alphanumeric and no longer than 20 characters`);
            }
        }

        const debitAccount = Body?.Debit_Acct_No;
        if (!debitAccount || !debitAccounts[debitAccount]) {
            return sendErrorResponseCode(res, Header, "ER002", "Invalid or unregistered Debit_Acct_No.");
        }

        if (debitAccounts[debitAccount].owner !== Header.Corp_ID) {
            return sendErrorResponse(res, 401, "Unauthorized", "LDAP to CORP Mismatch");
        }

        const amount = parseFloat(Body?.Amount);
        if (isNaN(amount) || amount <= 0) {
            return sendErrorResponseCode(res, Header, "ER025", "Amount must be greater than or equal to 1");
        }

        if (amount > debitAccounts[debitAccount].balance) {
            return sendErrorResponseCode(res, Header, "ER12", "Insufficient balance in the Debit Account.");
        }

        const mode = Body?.Mode_of_Pay;
        const validModes = ["FT", "RTGS", "IMPS"];
        if (!validModes.includes(mode)) {
            return sendErrorResponseCode(res, Header, "ER002", "Invalid or missing Mode_of_Pay. Valid options are 'FT', 'RTGS', or 'IMPS'.");
        }

        if (mode === "RTGS" && amount < 200000) {
            return sendErrorResponseCode(res, Header, "ER002", "For RTGS, Amount must be ≥ Rs 2,00,000.");
        }

        if ((mode === "FT" || mode === "IMPS") && amount >= 200000) {
            return sendErrorResponseCode(res, Header, "ER002", "For FT and IMPS, Amount must be < Rs 2,00,000.");
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Basic ")) {
            return sendErrorResponse(res, 401, "Unauthorized", "Invalid LDAP Format");
        }

        const base64Credentials = authHeader.split(' ')[1];
        let decodedCredentials;
        try {
            decodedCredentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
        } catch (err) {
            return sendErrorResponse(res, 400, "Bad Request", "Invalid Base64 encoding in Authorization Header");
        }

        const [username, password] = decodedCredentials.split(':');
        const isAuthorized = authorizedUsers.some(user => user.username === username && user.password === password);
        if (!isAuthorized) {
            return sendErrorResponse(res, 401, "Unauthorized", "LDAP ID or Password is wrong");
        }

        if (Header.Corp_ID !== username) {
            return sendErrorResponse(res, 401, "Unauthorized", "LDAP to CORP Mismatched");
        }

        // Deduct balance and save
        debitAccounts[Body.Debit_Acct_No].balance -= amount;
        saveAccounts(); // <-- important to update the accounts.txt file!

        const response = {
            Single_Payment_Corp_Resp: {
                Header: {
                    TranID: Header.TranID,
                    Corp_ID: Header.Corp_ID,
                    Maker_ID: Header.Maker_ID,
                    Checker_ID: Header.Checker_ID,
                    Approver_ID: Header.Approver_ID,
                    Status: "success",
                    Error_Cde: {},
                    Error_Desc: {}
                },
                Body: {
                    RefNo: generateRandomString("REF", 12),
                    UTRNo: generateRandomString("UTR", 14),
                    PONum: generateRandomString("PO", 12),
                    Debit_Acct_No: Body.Debit_Acct_No,
                    Debit_Acct_Name: Body.Debit_Acct_Name,
                    Debit_IFSC: Body.Debit_IFSC,
                    Amount: Body.Amount,
                    Remaining_Balance: debitAccounts[Body.Debit_Acct_No].balance,
                    BenIFSC: Body.Ben_IFSC,
                    Ben_Acct_No: Body.Ben_Acct_No,
                    Ben_Name: Body.Ben_Name,
                    Ben_Email: Body.Ben_Email,
                    Ben_Mobile: Body.Ben_Mobile,
                    Txn_Time: getISTDateTime(),
                    Mode_of_Pay: Body.Mode_of_Pay
                },
                Signature: {
                    Signature: "Signature"
                }
            }
        };

        return res.status(200).json(response);

    } catch (error) {
        return sendErrorResponse(res, 500, "Internal Server Error", "Unexpected error", error.message);
    }
});

// Load data and start server
loadDatabase();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
