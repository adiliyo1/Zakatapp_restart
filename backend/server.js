const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: [
    'https://adiliyo1.github.io',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080',
    'http://localhost:5500', 
    'http://127.0.0.1:5500', 
    'https://adiliyo1.github.io',
    null // Allow file:// protocol for local HTML files
  ],
  credentials: true
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Plaid configuration
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// In-memory storage for demo (use a database in production)
const userTokens = new Map();

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get Plaid Link Token
app.post('/api/create-link-token', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const request = {
      user: {
        client_user_id: user_id,
      },
      client_name: 'ZakatEase',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    };

    const response = await plaidClient.linkTokenCreate(request);
    
    res.json({
      link_token: response.data.link_token,
      expiration: response.data.expiration
    });
  } catch (error) {
    console.error('Create link token error:', error);
    res.status(500).json({ 
      error: 'Failed to create link token',
      details: error.response?.data || error.message 
    });
  }
});

// Exchange public token for access token
app.post('/api/exchange-public-token', async (req, res) => {
  try {
    const { public_token, user_id } = req.body;
    
    if (!public_token || !user_id) {
      return res.status(400).json({ error: 'public_token and user_id are required' });
    }

    const response = await plaidClient.itemPublicTokenExchange({
      public_token: public_token,
    });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    // Store the access token (use database in production)
    userTokens.set(user_id, {
      access_token,
      item_id,
      created_at: new Date()
    });

    res.json({
      success: true,
      item_id: item_id
    });
  } catch (error) {
    console.error('Exchange token error:', error);
    res.status(500).json({ 
      error: 'Failed to exchange public token',
      details: error.response?.data || error.message 
    });
  }
});

// Get accounts
app.post('/api/accounts', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const userToken = userTokens.get(user_id);
    if (!userToken) {
      return res.status(404).json({ error: 'User not found or not connected to Plaid' });
    }

    const response = await plaidClient.accountsGet({
      access_token: userToken.access_token,
    });

    // Process accounts for Zakat calculation
    const processedAccounts = response.data.accounts.map(account => {
      const balance = getAccountBalance(account);
      const isZakatableDebt = isDebtAccount(account); // Only zakatable debts
      const isAnyDebt = isAnyDebtAccount(account); // All debts for display
      const isZakatableAsset = isZakatableAccount(account);
      
      // Determine if account is zakatable (either asset or debt)
      const isZakatable = isZakatableAsset || isZakatableDebt;
      
      return {
        id: account.account_id,
        name: account.name,
        type: account.type,
        subtype: account.subtype,
        balance: balance,
        is_zakatable: isZakatable,
        is_debt: isAnyDebt, // For display purposes
        is_zakatable_debt: isZakatableDebt, // For calculation purposes
        category: isAnyDebt ? 'debt' : (isZakatableAsset ? 'zakatable_asset' : 'non_zakatable_asset')
      };
    });

    // Calculate totals
    const zakatableAssets = processedAccounts
      .filter(acc => acc.category === 'zakatable_asset')
      .reduce((sum, acc) => sum + acc.balance, 0);
    
    const zakatableDebts = processedAccounts
      .filter(acc => acc.is_zakatable_debt)
      .reduce((sum, acc) => sum + acc.balance, 0);

    res.json({
      accounts: processedAccounts,
      zakatable_assets: zakatableAssets,
      zakatable_debts: zakatableDebts,
      net_zakatable_from_plaid: Math.max(0, zakatableAssets - zakatableDebts)
    });
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch accounts',
      details: error.response?.data || error.message 
    });
  }
});

// Calculate Zakat
app.post('/api/calculate-zakat', async (req, res) => {
  try {
    const { 
      user_id, 
      manual_assets = {},
      debts = {}
    } = req.body;

    // Get Plaid accounts if user is connected
    let plaidAssets = 0;
    let plaidDebts = 0;
    if (user_id && userTokens.has(user_id)) {
      try {
        const userToken = userTokens.get(user_id);
        const response = await plaidClient.accountsGet({
          access_token: userToken.access_token,
        });

        // Separate assets and zakatable debts
        response.data.accounts.forEach(account => {
          const balance = getAccountBalance(account);
          
          if (isDebtAccount(account)) {
            plaidDebts += balance; // Only zakatable debts
          } else if (isZakatableAccount(account)) {
            plaidAssets += balance;
          }
        });
      } catch (plaidError) {
        console.warn('Plaid account fetch failed, using manual assets only:', plaidError);
      }
    }

    // Calculate totals
    const manualAssetsTotal = Object.values(manual_assets).reduce((sum, val) => sum + parseFloat(val || 0), 0);
    const manualDebtsTotal = Object.values(debts).reduce((sum, val) => sum + parseFloat(val || 0), 0);
    
    const totalAssets = plaidAssets + manualAssetsTotal;
    const totalDebts = plaidDebts + manualDebtsTotal;
    const netWorth = Math.max(0, totalAssets - totalDebts);

    // Zakat calculation
    const GOLD_PRICE_PER_GRAM = await getCurrentGoldPrice();
    const NISAB_GOLD_GRAMS = 87.48;
    const NISAB_THRESHOLD = NISAB_GOLD_GRAMS * GOLD_PRICE_PER_GRAM;
    const ZAKAT_RATE = 0.025;

    const zakatOwed = netWorth >= NISAB_THRESHOLD ? netWorth * ZAKAT_RATE : 0;

    res.json({
      calculation: {
        plaid_assets: plaidAssets,
        plaid_debts: plaidDebts,
        manual_assets: manualAssetsTotal,
        manual_debts: manualDebtsTotal,
        total_assets: totalAssets,
        total_debts: totalDebts,
        net_worth: netWorth,
        nisab_threshold: NISAB_THRESHOLD,
        zakat_owed: zakatOwed,
        above_nisab: netWorth >= NISAB_THRESHOLD
      },
      gold_price: GOLD_PRICE_PER_GRAM,
      calculation_date: new Date().toISOString()
    });
  } catch (error) {
    console.error('Zakat calculation error:', error);
    res.status(500).json({ 
      error: 'Failed to calculate zakat',
      details: error.message 
    });
  }
});

// Helper functions
function isZakatableAccount(account) {
  const { type, subtype } = account;
  
  // Zakatable account types (assets)
  if (type === 'depository') {
    return ['checking', 'savings', 'cd', 'money market', 'cash management', 'paypal', 'hsa'].includes(subtype);
  }
  
  if (type === 'investment') {
    // Exclude retirement accounts that have withdrawal penalties
    const retirementAccounts = [
      '401k', '401a', '403b', '457b', 'ira', 'roth', 'roth 401k', 
      '529', 'pension', 'retirement', 'sep ira', 'simple ira', 
      'keogh', 'sarsep', 'thrift savings plan'
    ];
    
    // HSA investment accounts are zakatable
    if (subtype === 'hsa') {
      return true;
    }
    
    return !retirementAccounts.includes(subtype);
  }
  
  return false;
}

function isDebtAccount(account) {
  const { type, subtype } = account;
  
  // Credit cards are zakatable debts
  if (type === 'credit') {
    return true;
  }
  
  // Only certain loans are zakatable debts
  if (type === 'loan') {
    // Non-zakatable debts (don't count against zakat)
    const nonZakatableDebts = ['mortgage', 'student', 'auto'];
    return !nonZakatableDebts.includes(subtype);
  }
  
  return false;
}

// Helper function to check if account is any type of debt (for display purposes)
function isAnyDebtAccount(account) {
  const { type } = account;
  return type === 'credit' || type === 'loan';
}

function getAccountBalance(account) {
  // For debt accounts, return negative balance (what you owe)
  if (isDebtAccount(account)) {
    return Math.abs(account.balances.current || 0);
  }
  
  // For asset accounts, return positive balance
  return account.balances.current || 0;
}

async function getCurrentGoldPrice() {
  // Mock gold price - in production, fetch from a gold price API
  return 65; // USD per gram
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Zakat API server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.PLAID_ENV || 'sandbox'}`);
});