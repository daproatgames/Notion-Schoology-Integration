require('dotenv').config();

const schoology = require('./schoology.js');
const notion = require('./notion.js');

const VALID_SUBJECTS = ['Math', 'History', 'Tech Design', 'Music', 'French', 'English', 'Science'];
const sectionCache = new Map();
const assignmentsCache = new Map();

function ymd(date) {
    const d = new Date(date);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function parseJsonEnv(name, fallback = {}) {
    if (!process.env[name]) return fallback;
    try { return JSON.parse(process.env[name]); }
    catch (error) { throw new Error(`${name} must be valid JSON`); }
}

const SECTION_SUBJECT_MAP = parseJsonEnv('SECTION_SUBJECT_MAP_JSON', {});

function inferSubjectFromTitle(title = '') {
    const t = title.toLowerCase();
    const rules = [
        ['Math', ['math', 'mathematics', 'algebra', 'functions', 'calculus']],
        ['History', ['history', 'social studies']],
        ['Tech Design', ['tech design', 'technology design', 'design technology']],
        ['Music', ['music', 'band', 'guitar']],
        ['French', ['french', 'français', 'francais']],
        ['English', ['english', 'language arts']],
        ['Science', ['science', 'biology', 'chemistry', 'physics']],
    ];
    for (const [subject, needles] of rules) {
        if (needles.some(n => t.includes(n))) return subject;
    }
    return null;
}

async function getSection(sectionId) {
    const id = String(sectionId || '');
    if (!id) return null;
    if (!sectionCache.has(id)) sectionCache.set(id, schoology.getCourseSection(id));
    return sectionCache.get(id);
}

async function subjectForSection(sectionId) {
    const id = String(sectionId || '');
    const explicit = SECTION_SUBJECT_MAP[id];
    if (VALID_SUBJECTS.includes(explicit)) return explicit;
    const section = await getSection(id);
    const title = section?.course_title || section?.section_title || section?.title || '';
    return inferSubjectFromTitle(title);
}

function inferTaskType(event) {
    const text = `${event.type || ''} ${event.title || ''}`.toLowerCase();
    if (text.includes('test') || text.includes('exam')) return 'Test';
    if (text.includes('quiz') || text.includes('assessment')) return 'Quiz';
    if (text.includes('lab')) return 'Lab';
    if (text.includes('project') || text.includes('presentation')) return 'Project';
    if (text.includes('read')) return 'Reading';
    if (text.includes('study') || text.includes('review')) return 'Study';
    return 'Homework';
}

function normalizeEventDate(start) {
    if (!start) return null;
    const match = String(start).match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
}

async function syncAssignmentInbox() {
    const lookback = Number(process.env.ASSIGNMENT_LOOKBACK_DAYS || 2);
    const lookahead = Number(process.env.ASSIGNMENT_LOOKAHEAD_DAYS || 30);
    const start = ymd(addDays(new Date(), -lookback));
    const end = ymd(addDays(new Date(), lookahead));
    const events = await schoology.getUserEvents(process.env.SCHOOLOGY_USER_ID, start, end);

    let created = 0;
    let updated = 0;
    for (const event of events) {
        if (!event.id || !event.title) continue;
        const result = await notion.upsertAssignmentInbox({
            schoologyId: String(event.id),
            title: event.title,
            subject: await subjectForSection(event.section_id),
            due: normalizeEventDate(event.start),
            type: inferTaskType(event),
            link: event.web_url || null,
            description: event.description || '',
        });
        result.created ? created++ : updated++;
    }
    console.log(`Assignment inbox: ${created} new, ${updated} refreshed.`);
}

async function processApprovedAssignments() {
    const approved = await notion.getApprovedInboxItems();
    let created = 0;
    let alreadyThere = 0;
    for (const inboxPage of approved) {
        const result = await notion.createSchoolTaskFromInbox(inboxPage);
        result.created ? created++ : alreadyThere++;
        await notion.markInboxImported(inboxPage.id);
    }
    console.log(`Approvals: ${created} task(s) added, ${alreadyThere} already existed.`);
}

async function assignmentsForSection(sectionId) {
    const id = String(sectionId);
    if (!assignmentsCache.has(id)) {
        assignmentsCache.set(id, schoology.getSectionAssignments(id).catch(() => []));
    }
    return assignmentsCache.get(id);
}

function gradeDisplay(item) {
    if (Number(item.exception) === 1) return 'Excused';
    if (Number(item.exception) === 2) return 'Incomplete';
    if (item.pending) return 'Pending';
    if (item.grade === null || item.grade === undefined || item.grade === '') return '—';
    const max = Number(item.max_points);
    if (Number.isFinite(max) && max > 0) return `${item.grade}/${max}`;
    return String(item.grade);
}

function gradePercent(item) {
    const earned = Number(item.grade);
    const max = Number(item.max_points);
    return Number.isFinite(earned) && Number.isFinite(max) && max > 0
        ? Math.round((earned / max) * 10000) / 100
        : null;
}

function timestampToIso(timestamp) {
    const n = Number(timestamp);
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
}

async function syncGrades() {
    const data = await schoology.getUserGrades(process.env.SCHOOLOGY_USER_ID);
    const sections = data.section || [];
    let synced = 0;

    for (const sectionGrade of sections) {
        const sectionId = String(sectionGrade.section_id);
        const subject = await subjectForSection(sectionId);
        if (!subject) {
            console.warn(`Skipping grades for unmapped Schoology section ${sectionId}. Add it to SECTION_SUBJECT_MAP_JSON.`);
            continue;
        }

        const assignments = await assignmentsForSection(sectionId);
        const assignmentMap = new Map(assignments.map(a => [String(a.id ?? a.grade_item_id), a]));
        const categoryMap = new Map((sectionGrade.grading_category || []).map(c => [String(c.id), c.title]));

        for (const period of sectionGrade.period || []) {
            for (const grade of period.assignment || []) {
                const assignmentId = String(grade.assignment_id || '');
                let gradeItem = assignmentMap.get(assignmentId);
                if (!gradeItem && grade.location) gradeItem = await schoology.getGradeItemFromLocation(grade.location);
                const title = gradeItem?.title || `${grade.type === 'discussion' ? 'Discussion' : 'Grade item'} ${assignmentId}`;
                const maxPoints = Number(grade.max_points ?? gradeItem?.max_points);
                const earned = Number(grade.grade);

                await notion.upsertGrade({
                    key: `item:${sectionId}:${period.period_id}:${assignmentId}:${grade.type || 'assignment'}`,
                    title,
                    subject,
                    kind: 'Assignment',
                    display: gradeDisplay(grade),
                    pointsEarned: Number.isFinite(earned) ? earned : null,
                    maxPoints: Number.isFinite(maxPoints) ? maxPoints : null,
                    percent: gradePercent({ ...grade, max_points: maxPoints }),
                    category: categoryMap.get(String(grade.category_id)) || '',
                    gradingPeriod: period.period_title || String(period.period_id || ''),
                    link: gradeItem?.web_url || grade.location || null,
                    sectionId,
                    lastUpdated: timestampToIso(grade.timestamp),
                });
                synced++;
            }
        }

        const periodTitle = new Map((sectionGrade.period || []).map(p => [String(p.period_id), p.period_title]));
        for (const finalGrade of sectionGrade.final_grade || []) {
            const periodId = String(finalGrade.period_id || 'final');
            const value = finalGrade.grade;
            const numeric = Number(value);
            await notion.upsertGrade({
                key: `final:${sectionId}:${periodId}`,
                title: periodId === 'final' ? 'Course Average — Final' : `Course Average — ${periodTitle.get(periodId) || periodId}`,
                subject,
                kind: 'Course Average',
                display: value === null || value === undefined || value === '' ? '—' : `${value}${Number.isFinite(numeric) ? '%' : ''}`,
                pointsEarned: null,
                maxPoints: null,
                percent: Number.isFinite(numeric) ? numeric : null,
                category: '',
                gradingPeriod: periodTitle.get(periodId) || periodId,
                link: null,
                sectionId,
                lastUpdated: new Date().toISOString(),
            });
            synced++;
        }
    }

    console.log(`Grades: ${synced} grade row(s) synced.`);
}

async function main() {
    if (!process.env.SCHOOLOGY_USER_ID) throw new Error('Missing required environment variable: SCHOOLOGY_USER_ID');

    await syncAssignmentInbox();
    await processApprovedAssignments();
    await syncGrades();
}

main().catch(error => {
    const message = error.response?.data ? JSON.stringify(error.response.data) : error.stack || error.message;
    console.error(message);
    process.exitCode = 1;
});
