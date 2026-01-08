
let footprintChart = null;

const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwGX_eFBqW8a3XXyzlqx2giEdmY7DyBaVRIB6fVTFcQHvcB-kkBGOXCrCRnL-GML81t/exec';


// Centralized emission factors (authoritative sources)
// All values are provided as follows and documented per category below.
// NOTE: Do not change UI or input expectations — inputs remain monthly (km per month, kWh per month, diet selected).
const EMISSION_FACTORS = {
    // Electricity
    // Unit: kg CO2 per kWh
    // Source: Central Electricity Authority (CEA India), 2024
    // Assumption: national grid average (India)
    electricity: 0.727,

    // Travel modes (used for non-personal travel distance inputs; units: kg CO2 per km)
    // Sources: IPCC, UK BEIS, India GHG Program, Indian Railways (2015–2024)
    travel: {
        // Generic car (used when user selects "car" as travel mode)
        car: 0.171,       // Petrol car / sedan equivalence (kg CO2 per km)
        bus: 0.015,       // Bus per passenger-km (kg CO2 per km)
        train: 0.008,     // Train / Metro per passenger-km (kg CO2 per km)
        plane: 0.246      // Domestic flight (short-haul) (kg CO2 per km)
    },

    // Personal vehicle types (used for personal vehicle distance inputs; units: kg CO2 per km)
    // Sources: IPCC, UK BEIS, India GHG Program (2015–2024)
    vehicle: {
        sedan: 0.171,     // Petrol sedan (kg CO2 per km)
        suv: 0.200,       // SUV average (kg CO2 per km)
        truck: 0.738,     // Heavy-duty truck (kg CO2 per km)
        motorcycle: 0.114 // Motorcycle (kg CO2 per km)
    },

    // Diet emissions (given as kg CO2e per person per DAY)
    // Source: Rodríguez-Martín et al., Frontiers in Nutrition, 2025
    // Unit: kg CO2e per person per day
    // NOTE: these are per-day factors — conversion to monthly is performed at calculation time
    diet: {
        vegan: 2.1,
        vegetarian: 2.6,
        omnivore: 3.8
    }
};

const TIPS = {
    travel: [
        'Bundle errands to cut unnecessary kilometers.',
        'Swap one weekly drive with public transport.',
        'Offset occasional flights through vetted programs.'
    ],
    vehicle: [
        'Keep tires inflated to reduce drag by up to 3%.',
        'Plan carpools for repeated commutes.',
        'Explore telematics or eco-driving modes.'
    ],
    diet: [
        'Try one plant-based day per week.',
        'Reduce meat portions by 20% without skipping protein.',
        'Shop seasonal produce to shrink shipping emissions.'
    ],
    electricity: [
        'Unplug idle electronics with a smart strip.',
        'Set AC/heat two degrees closer to outdoor temps.',
        'Upgrade to LED bulbs or ENERGY STAR appliances.'
    ]
};

// Wait for DOM to load
document.addEventListener('DOMContentLoaded', function() {
    const calculateBtn = document.getElementById('calculateBtn');
    const heroCta = document.getElementById('heroCta');
    const clearBtn = document.getElementById('clearHistoryBtn');
    const langBtn = document.getElementById('langBtn');
    const shareBtn = document.getElementById('shareBtn');
    let currentLang = localStorage.getItem('greenmeter_lang') || 'en';

    if (calculateBtn) {
        calculateBtn.addEventListener('click', async () => {
            const btn = document.getElementById('calculateBtn');
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Loading...';
            }
            try {
                await calculateCarbonFootprint();
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Calculate Carbon Footprint';
                }
            }
        });
    }

    if (heroCta) {
        heroCta.addEventListener('click', function () {
            const form = document.getElementById('carbonForm');
            if (form) {
                form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', clearLocalHistory);
    }

    // Language toggle
    if (langBtn) {
        langBtn.addEventListener('click', function() {
            currentLang = currentLang === 'en' ? 'hi' : 'en';
            localStorage.setItem('greenmeter_lang', currentLang);
            applyLanguage(currentLang);
        });
    }

    // Share button handler (mobile share / clipboard fallback)
    if (shareBtn) {
        shareBtn.addEventListener('click', async function() {
            const totalLabel = document.getElementById('totalFootprintLabel');
            const largest = document.getElementById('largestContributor');
            const title = 'My GreenMeter Result';
            const text = `${title}\nTotal: ${totalLabel ? totalLabel.textContent : '–'}\nLargest: ${largest ? largest.textContent : '–'}\nCheck yours: ${location.href}`;

            try {
                if (navigator.share) {
                    await navigator.share({ title, text, url: location.href });
                } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                    alert('Result copied to clipboard. You can paste it into messages.');
                } else {
                    // Fallback: select & copy from temporary textarea
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                    alert('Result copied to clipboard.');
                }
            } catch (err) {
                console.error('Share failed', err);
                alert('Unable to share on this device.');
            }
        });
    }

    // Apply persisted language on load
    applyLanguage(currentLang);
});

// Local storage key for history
const HISTORY_KEY = 'greenmeter_history';

/**
 * Save an entry to local history in localStorage.
 * Keeps only the last 50 entries (trim older ones).
 * Entry shape: { timestamp, travelCO2, vehicleCO2, dietCO2, electricityCO2, totalCO2 }
 */
function saveToLocalHistory(entry) {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const list = raw ? JSON.parse(raw) : [];
        // Add to front so newest come first
        list.unshift(entry);
        // Trim to 50 entries
        if (list.length > 50) list.length = 50;
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
        // If storage is disabled or quota exceeded, fail silently
        console.warn('Could not save history to localStorage', e);
    }
}

/**
 * Clear local history from localStorage and re-render the table.
 * This is bound to the "Clear history" button in the UI.
 */
function clearLocalHistory() {
    try {
        localStorage.removeItem(HISTORY_KEY);
    } catch (e) {
        console.warn('Could not clear history from localStorage', e);
    }
    renderHistoryTable();
}

/**
 * Retrieve stored history from localStorage.
 * If `limit` is provided, return up to that many most-recent entries.
 */
function getLocalHistory(limit) {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return typeof limit === 'number' ? list.slice(0, limit) : list;
    } catch (e) {
        console.warn('Could not read history from localStorage', e);
        return [];
    }
}

/**
 * Render the most recent 5 history entries into the #historyTable.
 * Shows timestamp (localized) and totalCO2.
 */
function renderHistoryTable() {
    const rows = getLocalHistory(5);
    const tbody = document.querySelector('#historyTable tbody');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="2">No history yet. Run a calculation to save results.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map(r => {
        const ts = new Date(r.timestamp).toLocaleString();
        return `<tr><td>${ts}</td><td>${(r.totalCO2 || 0).toFixed(2)}</td></tr>`;
    }).join('');
}

// Render history on page load so users see past calculations immediately
document.addEventListener('DOMContentLoaded', function () {
    renderHistoryTable();
});

// BEHAVIORAL TRACKING
function getBehavioralData() {
  const history = getLocalHistory();
  const now = new Date();
  const monthId = now.toISOString().slice(0, 7); // "2025-12"
  const isRepeat = history.length >= 2;
  const deltaCO2 = isRepeat && history[history.length-1]?.totalCO2 ? 
    ((history[history.length-1].totalCO2 - history[0].totalCO2) / history[history.length-1].totalCO2 * 100).toFixed(1) : 0;
  
  return {
    calc_count: history.length + 1,
    month_id: monthId,
    is_repeat_user: isRepeat,
    delta_co2_percent: deltaCO2,
    days_since_first: history.length ? Math.floor((now - new Date(history[history.length-1].timestamp)) / 86400000) : 0
  };
}

// VALIDATED AQI FALLBACK (CPCB Dec 2025 data)
async function getCityAQI(city) {
  const FALLBACK_AQI = {
    'Delhi': {aqi: 350, category: 'Very Poor'},      // CPCB winter avg
    'Mumbai': {aqi: 180, category: 'Moderate'},
    'Pune': {aqi: 220, category: 'Poor'},
    'Bengaluru': {aqi: 160, category: 'Moderate'},
    'Hyderabad': {aqi: 190, category: 'Moderate'}
  };
  return FALLBACK_AQI[city] || {aqi: 150, category: 'Moderate'};
}

// --- REPLACE EXISTING calculateCarbonFootprint FUNCTION WITH THIS ---

async function calculateCarbonFootprint() {
    // 1. Get Inputs
    const travelDistanceRaw = document.getElementById('travelDistance').value;
    const travelDistance = parseFloat(travelDistanceRaw) || 0;
    const travelMode = document.getElementById('travelMode').value;
    
    const vehicleType = document.getElementById('vehicleType').value;
    const vehicleDistanceRaw = document.getElementById('vehicleDistance').value;
    const vehicleDistance = parseFloat(vehicleDistanceRaw) || 0;
    
    const dietType = document.getElementById('dietType').value;
    
    const electricityUsageRaw = document.getElementById('electricityUsage').value;
    const electricityUsage = parseFloat(electricityUsageRaw) || 0;

    // NEW INPUTS (Step 5 & 6)
    const perceivedRaw = document.getElementById('perceived-footprint') ? document.getElementById('perceived-footprint').value : '';
    const cityRaw = document.getElementById('user-city') ? document.getElementById('user-city').value : '';
    const incomeRaw = document.getElementById('income-group') ? document.getElementById('income-group').value : '';

    // 2. Validate
    const inputData = {
        travelDistanceRaw, travelDistance, travelMode,
        vehicleDistanceRaw, vehicleDistance, vehicleType,
        dietType,
        electricityUsageRaw, electricityUsage
    };

    const validation = validateInputs(inputData);
    const errorBox = document.getElementById('errorBox');
    
    // Check specific validation for new mandatory fields
    if (!cityRaw) validation.errors.push("Please select your city for AQI context.");
    if (!perceivedRaw) validation.errors.push("Please estimate your footprint (Low/Med/High).");

    if (!validation.valid || validation.errors.length > 0) {
        if (errorBox) {
            errorBox.innerHTML = '<ul>' + validation.errors.map(e => `<li>${e}</li>`).join('') + '</ul>';
            errorBox.style.display = 'block';
        }
        return; 
    }
    if (errorBox) { errorBox.innerHTML = ''; errorBox.style.display = 'none'; }

    // 3. Calculate Emissions
    let travelFootprint = 0;
    if (travelDistance > 0 && travelMode && EMISSION_FACTORS.travel[travelMode]) {
        travelFootprint = travelDistance * EMISSION_FACTORS.travel[travelMode];
    }

    let vehicleFootprint = 0;
    if (vehicleDistance > 0 && vehicleType && EMISSION_FACTORS.vehicle[vehicleType]) {
        vehicleFootprint = vehicleDistance * EMISSION_FACTORS.vehicle[vehicleType];
    }

    let dietFootprint = 0;
    if (dietType && EMISSION_FACTORS.diet[dietType]) {
        dietFootprint = EMISSION_FACTORS.diet[dietType] * 30; // Monthly conversion
    }

    let electricityFootprint = 0;
    if (electricityUsage > 0) {
        electricityFootprint = electricityUsage * EMISSION_FACTORS.electricity;
    }

    const totalFootprint = travelFootprint + vehicleFootprint + dietFootprint + electricityFootprint;

    const breakdown = {
        travel: travelFootprint,
        vehicle: vehicleFootprint,
        diet: dietFootprint,
        electricity: electricityFootprint
    };

    // 4. Handle AQI & Context (Step 6)
    let aqiData = { aqi: 0, category: 'Unknown' };
    if (cityRaw) {
        aqiData = await getCityAQI(cityRaw);
        displayAQIContext(cityRaw, aqiData); // Helper function to show UI warning
    }

    // 5. Behavioral Data (Step 8)
    const behavioral = getBehavioralData();

    // 6. Save to Local History
    const entry = {
        timestamp: new Date().toISOString(),
        travelCO2: travelFootprint,
        vehicleCO2: vehicleFootprint,
        dietCO2: dietFootprint,
        electricityCO2: electricityFootprint,
        totalCO2: totalFootprint,
        city: cityRaw // Save city to local history too
    };
    saveToLocalHistory(entry);
    renderHistoryTable();

    // 7. Send to Google Sheets (Step 4 Schema)
    sendToGoogleSheets({
        breakdown,
        total: totalFootprint,
        city: cityRaw,
        perceived: perceivedRaw,
        income: incomeRaw,
        aqi: aqiData,
        behavioral: behavioral
    });

    // 8. Display Results
    displayResults(breakdown, totalFootprint);
}

// --- HELPER: Display AQI Context ---
function displayAQIContext(city, aqiData) {
    const resultSection = document.getElementById('resultSection');
    // Remove existing AQI banner if any
    const existing = document.getElementById('aqiBanner');
    if(existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'aqiBanner';
    div.style.cssText = 'background:#f0f8ff; border-left: 5px solid #2196F3; padding:15px; margin-bottom:20px; border-radius:4px;';
    
    let advice = "Air quality is acceptable.";
    if(aqiData.aqi > 200) advice = "⚠️ Air quality is Poor. Consider reducing outdoor travel.";
    if(aqiData.aqi > 300) advice = "⛔ Air quality is Very Poor. Avoid outdoor exertion.";

    div.innerHTML = `<strong>${city} AQI: ${aqiData.aqi} (${aqiData.category})</strong><br><small>${advice}</small>`;
    
    // Insert after the header
    const header = resultSection.querySelector('.section-header');
    if(header) header.after(div);
}



function displayResults(breakdown, total) {
    const resultsDiv = document.getElementById('results');

    let html = '<div class="breakdown">';
    html += '<h3>Breakdown:</h3>';

    Object.entries(breakdown).forEach(([key, value]) => {
        if (value > 0) {
            const label = key.charAt(0).toUpperCase() + key.slice(1);
            html += `<p><strong>${label}:</strong> ${value.toFixed(2)} kg CO₂e</p>`;
        }
    });

    html += `<hr><h3>Total Carbon Footprint: <span>${total.toFixed(2)} kg CO₂e</span></h3>`;
    html += '</div>';

    resultsDiv.innerHTML = html;

    updateSummaryCards(breakdown);
    updateHero(total, breakdown);
    updateInsights(breakdown);
    updateTips(getLargestCategory(breakdown));
    drawPieChart(breakdown);
}

function updateSummaryCards(breakdown) {
    const mapping = {
        travel: 'summaryTravel',
        vehicle: 'summaryVehicle',
        diet: 'summaryDiet',
        electricity: 'summaryElectricity'
    };

    Object.entries(mapping).forEach(([key, elementId]) => {
        const el = document.getElementById(elementId);
        if (el) {
            el.textContent = `${(breakdown[key] || 0).toFixed(2)} kg`;
        }
    });

    const totalLabel = document.getElementById('totalFootprintLabel');
    if (totalLabel) {
        const total = Object.values(breakdown).reduce((acc, val) => acc + val, 0);
        totalLabel.textContent = `${total.toFixed(2)} kg CO₂e / month`;
    }

    const largestContributor = document.getElementById('largestContributor');
    if (largestContributor) {
        const largest = getLargestCategory(breakdown);
        largestContributor.textContent = largest ? largest.label : 'No emissions recorded yet';
    }
}

function updateHero(total, breakdown) {
    const heroTotal = document.getElementById('heroTotal');
    const heroLargestLabel = document.getElementById('heroLargestLabel');
    const lastUpdated = document.getElementById('lastUpdated');

    if (heroTotal) {
        heroTotal.textContent = total.toFixed(2);
    }

    if (heroLargestLabel) {
        const largest = getLargestCategory(breakdown);
        heroLargestLabel.textContent = largest ? largest.label : 'No category yet';
    }

    if (lastUpdated) {
        lastUpdated.textContent = total > 0 ? new Date().toLocaleString() : '–';
    }
}

function updateInsights(breakdown) {
    const container = document.getElementById('insightCards');
    if (!container) return;

    const entries = Object.entries(breakdown)
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
        container.innerHTML = '<article class="insight-card empty"><p>Run a calculation to surface personalized insights.</p></article>';
        return;
    }

    container.innerHTML = '';

    entries.slice(0, 3).forEach(([key, value], index) => {
        const card = document.createElement('article');
        card.className = `insight-card${index === 0 ? ' highlight' : ''}`;
        card.innerHTML = `
            <h4>${formatLabel(key)}</h4>
            <p>${value.toFixed(2)} kg CO₂e</p>
            <p><small>${getInsightCopy(key)}</small></p>
        `;
        container.appendChild(card);
    });
}

function updateTips(largestCategory) {
    const tipsList = document.getElementById('tipsList');
    if (!tipsList) return;

    if (!largestCategory) {
        tipsList.innerHTML = '<li>Enter your data to reveal targeted tips.</li>';
        return;
    }

    const tips = TIPS[largestCategory.key] || [];

    tipsList.innerHTML = tips
        .map(tip => `<li>${tip}</li>`)
        .join('');
}

function drawPieChart(breakdown) {
    const ctx = document.getElementById('pieChart').getContext('2d');

    // 1. Prepare Data
    const labels = [];
    const data = [];
    const bgColors = [];
    
    const colorMap = {
        travel: '#2d5a2d',      // Dark Green
        vehicle: '#5a9a5a',     // Medium Green
        diet: '#8dc89e',        // Light Green
        electricity: '#b6dfb6'  // Pale Green
    };

    Object.entries(breakdown).forEach(([key, value]) => {
        if (value > 0) {
            labels.push(key.charAt(0).toUpperCase() + key.slice(1));
            data.push(value.toFixed(1));
            bgColors.push(colorMap[key] || '#cccccc');
        }
    });

    // 2. Destroy previous instance to prevent glitches
    if (footprintChart) {
        footprintChart.destroy();
    }

    // 3. Render new Chart
    footprintChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: bgColors,
                borderWidth: 2,
                borderColor: '#ffffff',
                hoverOffset: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font: { family: "'Inter', sans-serif", size: 14 },
                        color: '#2d5a2d',
                        padding: 20
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return ` ${context.label}: ${context.raw} kg CO₂`;
                        }
                    },
                    backgroundColor: 'rgba(45, 90, 45, 0.9)',
                    padding: 12,
                    cornerRadius: 8
                }
            },
            animation: {
                animateScale: true,
                animateRotate: true
            }
        }
    });
}

function getLargestCategory(breakdown) {
    const entries = Object.entries(breakdown)
        .filter(([, value]) => value > 0)
        .sort((a, b) => b[1] - a[1]);

    if (!entries.length) return null;

    const [key, value] = entries[0];
    return {
        key,
        value,
        label: formatLabel(key)
    };
}

function getInsightCopy(key) {
    const copy = {
        travel: 'Consider combining trips or shifting to low-carbon transit.',
        vehicle: 'Short drives add up. Eco-driving modes and carpools help.',
        diet: 'Plant-forward meals can halve weekly emissions.',
        electricity: 'Track phantom loads and upgrade to efficient devices.'
    };

    return copy[key] || 'Keep tracking to uncover trends.';
}

function formatLabel(key) {
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Validate inputs before calculation.
 * Rules:
 * - Numeric inputs cannot be negative.
 * - At least one meaningful activity must be provided:
 *   travel (distance>0 + mode), vehicle (distance>0 + type), electricity (>0 kWh), or diet (type selected).
 * - Do not allow calculation if all inputs are empty or zero.
 * Returns: { valid: boolean, errors: string[] }
 */
function validateInputs(data) {
    const errors = [];

    // Negative number checks
    if (typeof data.travelDistance === 'number' && data.travelDistance < 0) {
        errors.push('Travel distance cannot be negative.');
    }
    if (typeof data.vehicleDistance === 'number' && data.vehicleDistance < 0) {
        errors.push('Vehicle distance cannot be negative.');
    }
    if (typeof data.electricityUsage === 'number' && data.electricityUsage < 0) {
        errors.push('Electricity usage cannot be negative.');
    }

    // Determine whether any meaningful activity was provided
    const travelProvided = data.travelDistance > 0 && data.travelMode;
    const vehicleProvided = data.vehicleDistance > 0 && data.vehicleType;
    const electricityProvided = data.electricityUsage > 0;
    const dietProvided = !!data.dietType; // dietType selected (non-empty)

    const anyActivity = travelProvided || vehicleProvided || electricityProvided || dietProvided;

    if (!anyActivity) {
        errors.push('Please provide at least one activity: travel, vehicle, electricity, or diet.');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}
/**
 * Sends calculation data to Google Sheets via Apps Script.
 * Uses 'no-cors' mode to bypass browser security restrictions on Google's redirects.
 */
// --- REPLACE sendToGoogleSheets FUNCTION ---
function sendToGoogleSheets(data) {
    // Construct the Master Prompt compliant payload
    const payload = {
        userId: getUserId(),
        timestamp: new Date().toISOString(),
        
        // Core Calc
        travelCO2: data.breakdown.travel,
        vehicleCO2: data.breakdown.vehicle,
        dietCO2: data.breakdown.diet,
        electricityCO2: data.breakdown.electricity,
        totalCO2: data.total,
        
        // Research Context (Step 4 & 5)
        city: data.city,
        perceived_footprint: data.perceived,
        income_group: data.income, // Optional
        
        // AQI Data (Step 6)
        aqi_value: data.aqi.aqi,
        aqi_category: data.aqi.category,
        
        // Behavioral (Step 8)
        calculation_index: data.behavioral.calc_count,
        is_repeat_user: data.behavioral.is_repeat_user,
        delta_co2: data.behavioral.delta_co2_percent
    };

    console.log("Sending Payload:", payload); // Debugging

    fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(() => console.log("Data sent to Sheets"))
    .catch(err => console.error('Error sending to Sheets:', err));
}

/**
 * specific helper to get or create a unique ID for the user.
 * It stores the ID in localStorage so it persists between visits.
 */
function getUserId() {
    let userId = localStorage.getItem('greenmeter_uid');
    
    // Logic: If no ID exists OR if it was a faulty test ID, generate a new one
    if (!userId || userId === "undefined" || userId.length < 10) {
        // Industry-standard unique ID generation
        userId = 'gm-' + crypto.randomUUID(); 
        localStorage.setItem('greenmeter_uid', userId);
    }
    return userId;
}

// Comprehensive translations + language helper
const TRANSLATIONS = {
    en: {
        heroTitle: "Measure your daily impact in a single glance.",
        heroDesc: "GreenMeter helps you translate travel, diet, and home energy data into a clear emissions profile.",
        heroCta: "Start calculating",
        calcTitle: "Calculate Your Carbon Footprint",
        lblTravel: "Travel (Public/Long Dist)",
        hintTravel: "Capture long-distance trips or daily commute.",
        lblVehicle: "Personal Vehicle",
        hintVehicle: "Daily driving in personal vehicles.",
        lblDiet: "Diet",
        hintDiet: "Average monthly footprint from food choices.",
        lblElec: "Electricity",
        hintElec: "Use the monthly figure from your utility bill.",
        lblCity: "City (for AQI)",
        lblPerception: "Your Perception",
        btnCalc: "Calculate Carbon Footprint",
        resTitle: "Your Carbon Footprint Results",
        shareBtn: "Share GreenMeter",
        // Chart Labels
        chartTravel: "Travel",
        chartVehicle: "Vehicle",
        chartDiet: "Diet",
        chartElec: "Electricity"
    },
    hi: {
        heroTitle: "एक नज़र में अपने दैनिक प्रभाव को मापें।",
        heroDesc: "GreenMeter आपकी यात्रा, आहार और घरेलू ऊर्जा के आंकड़ों को स्पष्ट कार्बन उत्सर्जन प्रोफाइल में बदलने में मदद करता है।",
        heroCta: "गणना शुरू करें",
        calcTitle: "अपने कार्बन फुटप्रिंट की गणना करें",
        lblTravel: "यात्रा (सार्वजनिक/लंबी दूरी)",
        hintTravel: "लंबी दूरी की यात्रा या दैनिक आवागमन को जोड़ें।",
        lblVehicle: "निजी वाहन",
        hintVehicle: "निजी वाहनों में दैनिक ड्राइविंग।",
        lblDiet: "आहार",
        hintDiet: "भोजन विकल्पों से औसत मासिक फुटप्रिंट।",
        lblElec: "बिजली (घरेलू)",
        hintElec: "अपने बिजली बिल से मासिक आंकड़ा उपयोग करें।",
        lblCity: "शहर (AQI के लिए)",
        lblPerception: "आपकी धारणा",
        btnCalc: "गणना करें",
        resTitle: "आपके परिणाम",
        shareBtn: "GreenMeter शेयर करें",
        // Chart Labels
        chartTravel: "यात्रा",
        chartVehicle: "वाहन",
        chartDiet: "आहार",
        chartElec: "बिजली"
    }
};

function applyLanguage(lang) {
    const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;

    // Loop through dictionary keys and apply to elements with matching IDs
    Object.entries(dict).forEach(([key, value]) => {
        // chart labels are handled separately
        if (key.startsWith('chart')) return;
        const el = document.getElementById(key);
        if (el) el.textContent = value;
    });

    // Buttons/inputs with different IDs
    const calcBtn = document.getElementById('calculateBtn');
    if (calcBtn && dict.btnCalc) calcBtn.textContent = dict.btnCalc;

    // Placeholders for numeric inputs
    const travelInput = document.getElementById('travelDistance');
    if (travelInput) travelInput.placeholder = (lang === 'hi') ? 'उदा. 120' : 'e.g., 120';
    const vehicleInput = document.getElementById('vehicleDistance');
    if (vehicleInput) vehicleInput.placeholder = (lang === 'hi') ? 'उदा. 45' : 'e.g., 45';
    const elecInput = document.getElementById('electricityUsage');
    if (elecInput) elecInput.placeholder = (lang === 'hi') ? 'उदा. 210' : 'e.g., 210';

    // Language toggle label explicitly
    const langBtn = document.getElementById('langBtn');
    if (langBtn) langBtn.textContent = (lang === 'hi') ? '🇺🇸 English' : '🇮🇳 हिंदी';

    // Update share button text
    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn && dict.shareBtn) shareBtn.textContent = dict.shareBtn;

    // Update result title if present
    const res = document.getElementById('resTitle');
    if (res && dict.resTitle) res.textContent = dict.resTitle;

    // Update Chart.js labels (order: travel, vehicle, diet, electricity)
    if (footprintChart && footprintChart.data) {
        footprintChart.data.labels = [
            dict.chartTravel,
            dict.chartVehicle,
            dict.chartDiet,
            dict.chartElec
        ];
        footprintChart.update();
    }
}
