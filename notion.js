const axios = require('axios').default;

const NOTION_VERSION = process.env.NOTION_VERSION || '2025-09-03';
const NOTION_BASE = 'https://api.notion.com/v1';

const IDS = {
    tasks: process.env.NOTION_TASKS_DATA_SOURCE_ID,
    inbox: process.env.NOTION_SCHOOLOGY_INBOX_DATA_SOURCE_ID,
    grades: process.env.NOTION_GRADES_DATA_SOURCE_ID,
};

function requireNotionEnv() {
    for (const name of [
        'NOTION_TOKEN',
        'NOTION_TASKS_DATA_SOURCE_ID',
        'NOTION_SCHOOLOGY_INBOX_DATA_SOURCE_ID',
        'NOTION_GRADES_DATA_SOURCE_ID',
    ]) {
        if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
    }
}

function client() {
    requireNotionEnv();
    return axios.create({
        baseURL: NOTION_BASE,
        headers: {
            Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
            'Content-Type': 'application/json',
            'Notion-Version': NOTION_VERSION,
        },
    });
}

async function queryDataSource(dataSourceId, filter) {
    const api = client();
    const results = [];
    let startCursor;
    do {
        const body = { page_size: 100 };
        if (filter) body.filter = filter;
        if (startCursor) body.start_cursor = startCursor;
        const { data } = await api.post(`/data_sources/${dataSourceId}/query`, body);
        results.push(...(data.results || []));
        startCursor = data.has_more ? data.next_cursor : null;
    } while (startCursor);
    return results;
}

function textContent(value) {
    if (value === undefined || value === null || value === '') return [];
    return [{ type: 'text', text: { content: String(value).slice(0, 2000) } }];
}

const prop = {
    title: value => ({ title: textContent(value) }),
    richText: value => ({ rich_text: textContent(value) }),
    select: value => value ? ({ select: { name: value } }) : ({ select: null }),
    date: value => value ? ({ date: { start: value } }) : ({ date: null }),
    url: value => ({ url: value || null }),
    checkbox: value => ({ checkbox: Boolean(value) }),
    number: value => ({ number: value === null || value === undefined || value === '' ? null : Number(value) }),
};

function readTitle(page, name) {
    return (page.properties?.[name]?.title || []).map(x => x.plain_text || x.text?.content || '').join('');
}
function readRichText(page, name) {
    return (page.properties?.[name]?.rich_text || []).map(x => x.plain_text || x.text?.content || '').join('');
}
function readSelect(page, name) { return page.properties?.[name]?.select?.name || null; }
function readDate(page, name) { return page.properties?.[name]?.date?.start || null; }
function readUrl(page, name) { return page.properties?.[name]?.url || null; }

async function createPage(dataSourceId, properties) {
    const { data } = await client().post('/pages', {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
    });
    return data;
}

async function updatePage(pageId, properties) {
    const { data } = await client().patch(`/pages/${pageId}`, { properties });
    return data;
}

async function findByRichText(dataSourceId, propertyName, value) {
    const rows = await queryDataSource(dataSourceId, {
        property: propertyName,
        rich_text: { equals: String(value) },
    });
    return rows[0] || null;
}

async function upsertAssignmentInbox(item) {
    const existing = await findByRichText(IDS.inbox, 'Schoology ID', item.schoologyId);
    const common = {
        Assignment: prop.title(item.title),
        Subject: prop.select(item.subject),
        Due: prop.date(item.due),
        Type: prop.select(item.type || 'Homework'),
        'Schoology Link': prop.url(item.link),
        'Schoology ID': prop.richText(item.schoologyId),
        'Section ID': prop.richText(item.sectionId),
        Description: prop.richText(item.description),
        'Last Synced': prop.date(new Date().toISOString()),
    };

    if (existing) {
        await updatePage(existing.id, common);
        return { created: false, page: existing };
    }

    const page = await createPage(IDS.inbox, {
        ...common,
        Decision: prop.select('Pending'),
        Imported: prop.checkbox(false),
    });
    return { created: true, page };
}

async function getApprovedInboxItems() {
    return queryDataSource(IDS.inbox, {
        and: [
            { property: 'Decision', select: { equals: 'Add' } },
            { property: 'Imported', checkbox: { equals: false } },
        ],
    });
}

async function findSchoolTaskBySchoologyId(schoologyId) {
    return findByRichText(IDS.tasks, 'Schoology ID', schoologyId);
}

async function createSchoolTaskFromInbox(inboxPage) {
    const schoologyId = readRichText(inboxPage, 'Schoology ID');
    const existing = await findSchoolTaskBySchoologyId(schoologyId);
    if (existing) return { created: false, page: existing };

    const title = readTitle(inboxPage, 'Assignment');
    const subject = readSelect(inboxPage, 'Subject');
    const type = readSelect(inboxPage, 'Type') || 'Homework';
    const due = readDate(inboxPage, 'Due');
    const link = readUrl(inboxPage, 'Schoology Link');
    const description = readRichText(inboxPage, 'Description');

    const page = await createPage(IDS.tasks, {
        Task: prop.title(title),
        Subject: prop.select(subject),
        Type: prop.select(type),
        Due: prop.date(due),
        Priority: prop.select('Medium'),
        Done: prop.checkbox(false),
        Link: prop.url(link),
        Notes: prop.richText(description),
        'Schoology ID': prop.richText(schoologyId),
    });
    return { created: true, page };
}

async function markInboxImported(pageId) {
    return updatePage(pageId, { Imported: prop.checkbox(true) });
}

async function upsertGrade(grade) {
    const existing = await findByRichText(IDS.grades, 'Schoology Grade Key', grade.key);
    const properties = {
        'Grade Item': prop.title(grade.title),
        Subject: prop.select(grade.subject),
        Kind: prop.select(grade.kind || 'Assignment'),
        'Grade Display': prop.richText(grade.display),
        'Points Earned': prop.number(grade.pointsEarned),
        'Max Points': prop.number(grade.maxPoints),
        Percent: prop.number(grade.percent),
        Category: prop.richText(grade.category),
        'Grading Period': prop.richText(grade.gradingPeriod),
        'Schoology Link': prop.url(grade.link),
        'Schoology Grade Key': prop.richText(grade.key),
        'Section ID': prop.richText(grade.sectionId),
        'Last Updated': prop.date(grade.lastUpdated || new Date().toISOString()),
    };
    if (existing) {
        await updatePage(existing.id, properties);
        return { created: false, page: existing };
    }
    const page = await createPage(IDS.grades, properties);
    return { created: true, page };
}

module.exports = {
    IDS,
    queryDataSource,
    upsertAssignmentInbox,
    getApprovedInboxItems,
    createSchoolTaskFromInbox,
    markInboxImported,
    upsertGrade,
};