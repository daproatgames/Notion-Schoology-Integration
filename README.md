# Schoology → Notion School Hub

This fork changes the original integration into a safer school workflow:

- **Assignments do not go straight into School Tasks.**
- New Schoology assignments first go to **Schoology Assignment Inbox** with **Decision = Pending**.
- Change Decision to **Add** to approve an assignment.
- On the next sync, approved items are added to **School Tasks** and marked **Imported**.
- Change Decision to **Ignore** to keep an item out of School Tasks.
- **Grades sync automatically** to **Schoology Grades** and are shown through the per-class grade views already embedded in Notion.

## Notion databases

The sync expects these data sources:

- School Tasks: `5df85cc6-c5e6-4290-98c2-10101ad9caae`
- Schoology Assignment Inbox: `7ae0b87e-6837-44cc-8a98-bb0b7564b5a2`
- Schoology Grades: `c54af276-c7c2-420e-8a5f-ad034d5e12e0`

The current Notion setup also has a hidden `Schoology ID` property in School Tasks so approved Schoology assignments do not duplicate.

## Setup

1. Clone this fork.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Fill in:
   - `SCHOOLOGY_CONSUMER_KEY`
   - `SCHOOLOGY_CONSUMER_SECRET`
   - `SCHOOLOGY_USER_ID`
   - `NOTION_TOKEN`
5. Share **School Tasks**, **Schoology Assignment Inbox**, and **Schoology Grades** with the Notion integration represented by `NOTION_TOKEN`.
6. Run:
   ```bash
   npm start
   ```

## Course / subject mapping

The script tries to infer subjects from Schoology course titles. If a course title is unusual, set an explicit mapping:

```env
SECTION_SUBJECT_MAP_JSON={"123456789":"Math","234567890":"French"}
```

Allowed values are:

`Math`, `History`, `Tech Design`, `Music`, `French`, `English`, `Science`.

If a section cannot be mapped, its grades are skipped and a warning is printed instead of writing them to the wrong class.

## Assignment approval flow

Each sync:

1. Reads Schoology calendar events.
2. Creates or refreshes matching rows in **Schoology Assignment Inbox**.
3. Leaves new rows as **Pending**.
4. Checks for rows you changed to **Add**.
5. Creates those rows in **School Tasks** exactly once.
6. Marks the inbox row **Imported**.

This means Schoology can suggest tasks, but it cannot silently pollute your main homework list.

## Grade flow

The script reads Schoology user-grade data and mirrors:

- assignment title
- subject
- grade display
- points earned
- max points
- percentage when calculable
- category
- grading period
- Schoology link
- last-updated time
- Schoology section / grade IDs

It also mirrors Schoology-provided course/final grade rows when they are returned by the API. The integration does **not** try to invent its own weighted course average.

## Security

Never commit your Schoology secret or Notion token. `.env` is already ignored by git.

If you run this with GitHub Actions, store credentials as GitHub Actions secrets instead.
