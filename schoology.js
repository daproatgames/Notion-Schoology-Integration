const axios = require('axios').default;
const { v4: uuidv4 } = require('uuid');

const API_BASE = process.env.SCHOOLOGY_API_BASE_URL || 'https://api.schoology.com/v1';

function requireSchoologyEnv() {
    for (const name of ['SCHOOLOGY_CONSUMER_KEY', 'SCHOOLOGY_CONSUMER_SECRET']) {
        if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
    }
}

function getHeaders() {
    requireSchoologyEnv();
    const key = process.env.SCHOOLOGY_CONSUMER_KEY;
    const secret = process.env.SCHOOLOGY_CONSUMER_SECRET;
    return {
        'Content-Type': 'application/json',
        'Authorization': `OAuth realm="Schoology API", oauth_consumer_key="${key}", oauth_token="", oauth_nonce="${uuidv4()}", oauth_timestamp="${Math.floor(Date.now() / 1000)}", oauth_signature_method="PLAINTEXT", oauth_version="1.0", oauth_signature="${encodeURIComponent(secret)}%26"`,
    };
}

async function apiGet(pathOrUrl, params = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl)
        ? pathOrUrl.replace(/^http:\/\//i, 'https://')
        : `${API_BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
    const response = await axios.get(url, { headers: getHeaders(), params });
    return response.data;
}

async function getUser(userID) {
    return apiGet(`/users/${userID}`);
}

async function getUserEvents(userID, startDate, endDate) {
    const data = await apiGet(`/users/${userID}/events`, {
        start_date: startDate,
        end_date: endDate,
        start: 0,
        limit: 200,
    });
    return data.event || [];
}

async function getCourseSection(sectionID) {
    return apiGet(`/sections/${sectionID}`);
}

async function getUserGrades(userID) {
    return apiGet(`/users/${userID}/grades`);
}

async function getSectionAssignments(sectionID) {
    const data = await apiGet(`/sections/${sectionID}/assignments`, { start: 0, limit: 200 });
    return data.assignment || [];
}

async function getGradeItemFromLocation(location) {
    if (!location) return null;
    try {
        return await apiGet(location);
    } catch (error) {
        return null;
    }
}

module.exports = {
    apiGet,
    getUser,
    getUserEvents,
    getCourseSection,
    getUserGrades,
    getSectionAssignments,
    getGradeItemFromLocation,
};