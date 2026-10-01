# Simple Gantt

A simple, straight-to-the-point Gantt chart that runs in your browser. It is a
single HTML file with no install, no build step and no dependencies.

![Simple Gantt screenshot](screenshot.png)

## Getting started

Open `index.html` in any modern browser (Chrome, Edge, Firefox, Safari).

On the first run, a few example tasks are added so the chart isn't empty.
Remove them with **Clear all**.

## Features

### Tasks
- **Add a task:** enter a name, an optional group, a start date and an end date, then click **Add task**.
- **Edit a task:** click its bar in the chart or the ✎ button in the list, change the details, then click **Save**.
- **Delete a task:** click ✕ in the list.
- A task's end date is included, so a task from the 3rd to the 5th lasts 3 days.

### Dragging in the chart
| Where you grab the bar | What changes |
|---|---|
| Left end | Only the start date |
| Right end | Only the end date |
| Middle | The whole task moves and keeps its length |

Bars snap to whole days. Press **Esc** while dragging to cancel. A grip line
shows at each end of a bar when you hover over it.

### Moving the tasks that come after
When a task's end date changes, by dragging or in the form, a dialog asks
whether to move the tasks that come after it by the same number of days:

- **Move this group:** only the later tasks in the same group.
- **Move all groups:** the later tasks in every group.
- **Don't move:** leave the other tasks where they are.

"Later" means the task starts after the changed task's original start date.

### Groups
- Type a group name in the **Group** field. Names you've already used are suggested as you type.
- Each group has a header row, plus a summary bar in the chart showing when the group starts and ends.
- Each group gets its own colour. A new group gets a random colour that no other group is using, and keeps it.
- Tasks are shown in a lighter shade of their group's colour, so groups and tasks are easy to tell apart.

### Milestones ◆
Set **Milestone** to **At start** or **At end** to mark a task as a milestone.
A diamond appears at that end of its bar in the chart, and before its name in
the list.

### Calendar
- The chart header shows the quarter (Q1–Q4), the month and year, and the day numbers.
- Weekends are shaded, and a red line marks today.
- The **Day width** slider zooms in and out.

### Saving, export and import
- Everything is saved automatically in your browser (`localStorage`), so your chart is still there when you reopen the file in the same browser.
- **Export JSON** downloads your tasks and group colours as `gantt.json`.
- **Import JSON** loads a file you exported earlier. It replaces the current chart.

Use export and import to back up your chart or move it to another browser or
computer.

## Project structure

Everything is in `index.html`:

- **`<style>`:** colours are CSS variables on `:root`, with a dark-mode version. The group colours are in `PALETTE` in the script.
- **Form and toolbar:** the HTML at the top of `<body>`.
- **`<script>`:**
  - storage: `load`, `save`, `syncGroupColors`
  - the form and the move-following-tasks dialog: `offerToShiftFollowing`, `askShift`
  - dragging: the `pointerdown`, `pointermove` and `pointerup` handlers
  - `render()`, which redraws the whole chart from the `tasks` array

Each task is stored as:

```json
{ "id": "…", "name": "Design", "group": "Planning", "start": "2026-10-03", "end": "2026-10-07", "milestone": "start" }
```

`milestone` is `""` (none), `"start"` or `"end"`.
