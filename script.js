/* Study Buddy ♡ — Supabase-backed personal accounts and synced assignments. */
'use strict';

const STORAGE = { tasks: 'study-buddy-tasks-v1', guestTasks: 'study-buddy-guest-tasks-v1', guestActive: 'study-buddy-guest-active-v1', theme: 'study-buddy-theme-v1', sessions: 'study-buddy-sessions-v1' };
const $ = (id) => document.getElementById(id);
const safeArray = (value) => Array.isArray(value) ? value : [];
const pad = (n) => String(n).padStart(2, '0');
const localYMD = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const todayYMD = () => localYMD(new Date());
const shiftYMD = (days) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + days); return localYMD(date); };
const dateFromYMD = (ymd) => { const [year, month, day] = ymd.split('-').map(Number); return new Date(year, month - 1, day, 12); };
const dayDistance = (ymd) => Math.round((dateFromYMD(ymd) - dateFromYMD(todayYMD())) / 86400000);
const formatDate = (ymd) => dateFromYMD(ymd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const priorityOrder = { High: 0, Medium: 1, Low: 2 };
const uid = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// Assignments are loaded from Supabase only after a user signs in.
let tasks = [];
let selectedDay = todayYMD();
const currentDate = new Date();
let calendarYear = currentDate.getFullYear();
let calendarMonth = currentDate.getMonth();
let activeView = 'dashboard';
let toastTimeout;
let sessionCount = 0;
let currentUser = null;
let guestMode = false;
let client = null;
let authMode = 'login';
let loadingAccount = 0;
let busy = false;
const cleanError = (error) => error?.message || 'Something went wrong. Please try again.';
const mapTask = row => ({
  id: row.id, title: row.title, course: row.course, due: row.due_date,
  priority: row.priority, completed: row.completed, created: new Date(row.created_at).getTime()
});
const sessionKey = userId => `${STORAGE.sessions}:${userId}`;
function readGuestTasks() {
  try {
    return safeArray(JSON.parse(localStorage.getItem(STORAGE.guestTasks) || '[]'))
      .filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' &&
        typeof item.course === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due))
      .map(item => ({ id: item.id, title: item.title, course: item.course, due: item.due,
        priority: ['Low','Medium','High'].includes(item.priority) ? item.priority : 'Medium',
        completed: !!item.completed, created: Number(item.created) || Date.now() }));
  } catch { return []; }
}
function saveGuestTasks() {
  try {
    localStorage.setItem(STORAGE.guestTasks, JSON.stringify(tasks));
    syncLabel('♡ Guest mode · saved on this device only');
    return true;
  } catch {
    syncLabel('⚠ Guest changes could not be saved');
    toast('Could not save in this browser. Check your storage settings.');
    return false;
  }
}
function enterGuestMode() {
  guestMode = true;
  currentUser = null;
  localStorage.setItem(STORAGE.guestActive, '1');
  tasks = readGuestTasks();
  sessionCount = Number(localStorage.getItem(sessionKey('guest')) || 0) || 0;
  $('accountEmail').textContent = '♡ Guest';
  $('signOutBtn').textContent = 'Sign in / Sign up';
  $('authScreen').hidden = true;
  $('appShell').hidden = false;
  clearForm();
  syncLabel('♡ Guest mode · saved on this device only');
  renderEverything();
  renderTimer();
}
function showSignInScreen() {
  guestMode = false;
  localStorage.removeItem(STORAGE.guestActive);
  tasks = [];
  currentUser = null;
  pauseTimer();
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  selectAuthMode('login');
  showAuthMessage('Your guest assignments are still saved in this browser, and won’t sync automatically.');
}
function syncLabel(message) { $('syncStatus').textContent = message; }
function showAuthMessage(message, isError = false) {
  $('authMessage').textContent = message;
  $('authMessage').classList.toggle('error', isError);
}
function setBusy(value) { busy = value; $('saveTaskBtn').disabled = value; }
async function loadAssignments() {
  if (!currentUser || !client) return;
  const userId = currentUser.id;
  syncLabel('☁ Loading your assignments…');
  const { data, error } = await client.from('assignments')
    .select('id,title,course,due_date,priority,completed,created_at')
    .order('created_at', { ascending: false });
  if (userId !== currentUser?.id) return;
  if (error) {
    syncLabel('⚠ Could not load assignments');
    toast(`Could not load assignments: ${cleanError(error)}`);
    return;
  }
  tasks = (data || []).map(mapTask);
  syncLabel('☁ Your assignments are saved online');
  renderEverything();
}
async function handleSession(session) {
  const user = session?.user || null;
  if (!user) {
    if (guestMode || localStorage.getItem(STORAGE.guestActive) === '1') {
      enterGuestMode();
      return;
    }
    currentUser = null;
    tasks = [];
    $('appShell').hidden = true;
    $('authScreen').hidden = false;
    showAuthMessage('');
    return;
  }
  if (currentUser?.id === user.id && !guestMode) return;
  const generation = ++loadingAccount;
  guestMode = false;
  localStorage.removeItem(STORAGE.guestActive);
  currentUser = user;
  $('signOutBtn').textContent = 'Log out';
  $('accountEmail').textContent = user.email || 'Signed in';
  sessionCount = Number(localStorage.getItem(sessionKey(user.id)) || 0) || 0;
  renderTimer();
  $('authScreen').hidden = true;
  $('appShell').hidden = false;
  clearForm();
  tasks = [];
  renderEverything();
  await loadAssignments();
  if (generation !== loadingAccount) return;
}
function selectAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('signupTab').classList.toggle('is-selected', signup);
  $('loginTab').classList.toggle('is-selected', !signup);
  $('authSubmit').textContent = signup ? 'Create account ♡' : 'Log in ♡';
  $('authPassword').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('forgotPassword').hidden = signup;
  $('newPasswordForm').hidden = true;
  $('authForm').hidden = false;
  showAuthMessage('');
}
$('loginTab').addEventListener('click', () => selectAuthMode('login'));
$('signupTab').addEventListener('click', () => selectAuthMode('signup'));
$('guestBtn').addEventListener('click', enterGuestMode);
$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!client || busy) return;
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (password.length < 8) { showAuthMessage('Use at least 8 characters.', true); return; }
  const submitButton = $('authSubmit');
  submitButton.disabled = true;
  showAuthMessage('One moment…');
  try {
    if (authMode === 'signup') {
      const { data, error } = await client.auth.signUp({
        email, password,
        options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` }
      });
      if (error) throw error;
      showAuthMessage(data.session ? 'Account created! Loading your planner…' : 'Check your email for a confirmation link, then log in ♡');
    } else {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      showAuthMessage('Welcome back! ♡');
    }
  } catch (error) { showAuthMessage(cleanError(error), true); }
  finally { submitButton.disabled = false; }
});
$('forgotPassword').addEventListener('click', async () => {
  if (!client) return;
  const email = $('authEmail').value.trim();
  if (!email) { showAuthMessage('Enter your email address above first.', true); return; }
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}${window.location.pathname}`
  });
  showAuthMessage(error ? cleanError(error) : 'If this email has an account, look for a password-reset link ♡', !!error);
});
$('newPasswordForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!client) return;
  const newPassword = $('newPassword').value;
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) return showAuthMessage(cleanError(error), true);
  $('newPasswordForm').hidden = true;
  $('authForm').hidden = false;
  showAuthMessage('Password updated! ♡');
  const { data } = await client.auth.getSession();
  await handleSession(data.session);
});
$('signOutBtn').addEventListener('click', async () => {
  if (guestMode) { showSignInScreen(); return; }
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) toast(cleanError(error));
  else await handleSession(null);
});
async function initializeAuth() {
  const url = (window.STUDY_BUDDY_SUPABASE_URL || '').trim();
  const key = (window.STUDY_BUDDY_SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!url.startsWith('https://') || !key.startsWith('sb_publishable_') || !window.supabase?.createClient) {
    $('setupWarning').hidden = false;
    $('authSubmit').disabled = true;
    showAuthMessage('Accounts need to be configured before sign-in will work. Guest mode is still available.', true);
    if (localStorage.getItem(STORAGE.guestActive) === '1') enterGuestMode();
    return;
  }
  try {
    client = window.supabase.createClient(url, key);
    client.auth.onAuthStateChange((event, session) => {
      // Run API calls outside the auth callback, avoiding async lock reentrancy.
      setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') {
          $('authScreen').hidden = false;
          $('appShell').hidden = true;
          $('authForm').hidden = true;
          $('newPasswordForm').hidden = false;
          showAuthMessage('Enter your new password below. ♡');
        } else if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') {
          void handleSession(session);
        }
      }, 0);
    });
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    await handleSession(data.session);
  } catch (error) { showAuthMessage(cleanError(error), true); }
}

function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.classList.remove('show'), 2600);
}
function changeView(view) {
  if (!['dashboard', 'assignments', 'calendar', 'focus', 'about'].includes(view)) view = 'dashboard';
  activeView = view;
  document.querySelectorAll('.nav-link').forEach(btn => {
    const selected = btn.dataset.view === view;
    btn.classList.toggle('is-active', selected);
    if (selected) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach(el => { const shown = el.id === `${view}View`; el.classList.toggle('is-visible', shown); el.hidden = !shown; });
  $('stats').hidden = !['dashboard', 'assignments'].includes(view);
  const names = { dashboard: 'Your dashboard', assignments: 'All assignments', calendar: 'Your calendar', focus: 'Focus time', about: 'About Study Buddy' };
  $('sectionName').textContent = names[view];
  if (view === 'calendar') renderCalendar();
  if (view === 'assignments') renderAllTasks();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function focusTaskForm() { changeView('dashboard'); $('quickAddPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('taskTitle').focus({ preventScroll: true }); }
function stats() {
  $('totalTasks').textContent = tasks.length;
  $('completedTasks').textContent = tasks.filter(task => task.completed).length;
  $('todayTasks').textContent = tasks.filter(task => !task.completed && task.due === todayYMD()).length;
  $('weekTasks').textContent = tasks.filter(task => !task.completed && dayDistance(task.due) >= 0 && dayDistance(task.due) <= 6).length;
}
function sorted(tasksInput, sortBy = 'due') {
  const rows = [...tasksInput];
  if (sortBy === 'recent') return rows.sort((a, b) => b.created - a.created);
  if (sortBy === 'priority') return rows.sort((a, b) => Number(a.completed) - Number(b.completed) || priorityOrder[a.priority] - priorityOrder[b.priority] || a.due.localeCompare(b.due));
  return rows.sort((a, b) => Number(a.completed) - Number(b.completed) || a.due.localeCompare(b.due) || priorityOrder[a.priority] - priorityOrder[b.priority]);
}
function dueText(task) {
  const diff = dayDistance(task.due);
  if (task.completed) return formatDate(task.due);
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} overdue`;
  return formatDate(task.due);
}
function taskRow(task) {
  const dueClass = !task.completed && dayDistance(task.due) < 0 ? 'overdue' : '';
  const row = document.createElement('div'); row.className = `task-row${task.completed ? ' is-done' : ''}`;
  row.innerHTML = `<input class="task-check" type="checkbox" aria-label="Mark ${escapeHTML(task.title)} complete" ${task.completed ? 'checked' : ''}>
    <div class="task-body"><span class="task-title">${escapeHTML(task.title)}</span><div class="task-meta"><span class="subject-tag">${escapeHTML(task.course)}</span><span class="task-date ${dueClass}">◷ ${escapeHTML(dueText(task))}</span><span class="priority-tag priority-${escapeHTML(task.priority.toLowerCase())}">${escapeHTML(task.priority)}</span></div></div>
    <div class="task-menu"><button type="button" class="edit" title="Edit assignment" aria-label="Edit ${escapeHTML(task.title)}">✎</button><button type="button" class="delete" title="Delete assignment" aria-label="Delete ${escapeHTML(task.title)}">×</button></div>`;
  row.querySelector('.task-check').addEventListener('change', async (event) => {
    const checked = event.target.checked;
    if (guestMode) {
      tasks = tasks.map(t => t.id === task.id ? { ...t, completed: checked } : t);
      saveGuestTasks();
      renderEverything();
      toast(checked ? 'Nice work! Assignment completed ♡' : 'Assignment moved back to your list');
      return;
    }
    if (!client || !currentUser) return;
    const { data, error } = await client.from('assignments').update({ completed: checked })
      .eq('id', task.id).eq('user_id', currentUser.id)
      .select('id,title,course,due_date,priority,completed,created_at').single();
    if (error) { event.target.checked = task.completed; toast(cleanError(error)); return; }
    tasks = tasks.map(t => t.id === task.id ? mapTask(data) : t);
    renderEverything();
    toast(checked ? 'Nice work! Assignment completed ♡' : 'Assignment moved back to your list');
  });
  row.querySelector('.edit').addEventListener('click', () => editTask(task.id));
  row.querySelector('.delete').addEventListener('click', () => removeTask(task.id));
  return row;
}
function fillList(element, subset, emptyMessage = 'No assignments here yet!') {
  element.replaceChildren();
  if (!subset.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.innerHTML = `<strong>All clear! ✿</strong>${escapeHTML(emptyMessage)}`; element.append(empty); return; }
  subset.forEach(task => element.append(taskRow(task)));
}
function renderDashboard() { fillList($('upcomingTasks'), sorted(tasks.filter(task => !task.completed)).slice(0, 5), 'Add your first assignment to get started. ♡'); }
function renderAllTasks() {
  const query = $('taskSearch').value.trim().toLowerCase(); const filter = $('statusFilter').value;
  const matching = tasks.filter(task => (filter === 'all' || (filter === 'completed') === task.completed) && (task.title.toLowerCase().includes(query) || task.course.toLowerCase().includes(query)));
  fillList($('allTasks'), sorted(matching, $('sortOrder').value), 'Try another search or add a new assignment.');
}
function renderCalendar() {
  $('monthLabel').textContent = new Date(calendarYear, calendarMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('calendarGrid').replaceChildren();
  const firstDow = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const cellCount = Math.ceil((firstDow + daysInMonth) / 7) * 7;
  for (let i = 0; i < cellCount; i++) {
    const date = new Date(calendarYear, calendarMonth, 1 - firstDow + i, 12);
    const ymd = localYMD(date);
    const dayTasks = tasks.filter(task => task.due === ymd);
    const button = document.createElement('button'); button.type = 'button';
    button.className = `calendar-day${date.getMonth() !== calendarMonth ? ' other-month' : ''}${ymd === todayYMD() ? ' today' : ''}${ymd === selectedDay ? ' selected' : ''}`;
    button.setAttribute('aria-label', `${formatDate(ymd)}: ${dayTasks.length} assignment${dayTasks.length === 1 ? '' : 's'}`);
    button.setAttribute('aria-pressed', String(ymd === selectedDay));
    const dots = dayTasks.slice(0, 5).map(task => `<span class="calendar-dot ${task.completed ? 'completed' : task.priority === 'High' ? 'high' : ''}"></span>`).join('');
    button.innerHTML = `<span class="day-number">${date.getDate()}</span><span class="calendar-dots" aria-hidden="true">${dots}</span>`;
    button.addEventListener('click', () => { selectedDay = ymd; calendarYear = date.getFullYear(); calendarMonth = date.getMonth(); renderCalendar(); });
    $('calendarGrid').append(button);
  }
  $('selectedDayLabel').textContent = `✿ ${formatDate(selectedDay)}`;
  fillList($('dayTasks'), sorted(tasks.filter(task => task.due === selectedDay)), 'Nothing due on this day. Enjoy the breathing room!');
}
function renderEverything() { stats(); renderDashboard(); renderAllTasks(); if (activeView === 'calendar') renderCalendar(); }
function clearForm() { $('assignmentForm').reset(); $('editingId').value = ''; $('saveTaskBtn').textContent = '✦ Add to my planner'; $('cancelEdit').hidden = true; $('taskDue').value = todayYMD(); }
function editTask(id) {
  const task = tasks.find(task => task.id === id); if (!task) return;
  $('editingId').value = task.id; $('taskTitle').value = task.title; $('taskCourse').value = task.course; $('taskDue').value = task.due; $('taskPriority').value = task.priority;
  $('saveTaskBtn').textContent = '♡ Save changes'; $('cancelEdit').hidden = false; focusTaskForm();
}
async function removeTask(id) {
  const task = tasks.find(task => task.id === id);
  if (!task || !window.confirm(`Delete "${task.title}"?`)) return;
  if (guestMode) {
    tasks = tasks.filter(item => item.id !== id);
    saveGuestTasks();
    if ($('editingId').value === id) clearForm();
    renderEverything(); toast('Assignment deleted');
    return;
  }
  if (!client || !currentUser) return;
  const { error } = await client.from('assignments').delete().eq('id', id).eq('user_id', currentUser.id);
  if (error) { toast(cleanError(error)); return; }
  tasks = tasks.filter(item => item.id !== id);
  if ($('editingId').value === id) clearForm();
  renderEverything(); toast('Assignment deleted');
}
$('assignmentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if ((!guestMode && (!currentUser || !client)) || busy) return;
  const title = $('taskTitle').value.trim();
  const course = $('taskCourse').value.trim();
  const due = $('taskDue').value; const priority = $('taskPriority').value;
  if (!title || !course || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !['High','Medium','Low'].includes(priority)) {
    toast('Please fill out all assignment details.'); return;
  }
  setBusy(true);
  try {
    const editId = $('editingId').value;
    if (guestMode) {
      if (editId) {
        tasks = tasks.map(t => t.id === editId ? { ...t, title, course, due, priority } : t);
      } else {
        tasks.push({ id: uid(), title, course, due, priority, completed: false, created: Date.now() });
      }
      saveGuestTasks();
      clearForm(); renderEverything();
      toast(editId ? 'Assignment updated ♡' : 'Assignment added! You got this ✿');
      return;
    }
    const values = { title, course, due_date: due, priority };
    let result;
    if (editId) {
      result = await client.from('assignments').update(values)
        .eq('id', editId).eq('user_id', currentUser.id)
        .select('id,title,course,due_date,priority,completed,created_at').single();
    } else {
      result = await client.from('assignments').insert({ ...values, user_id: currentUser.id })
        .select('id,title,course,due_date,priority,completed,created_at').single();
    }
    if (result.error) throw result.error;
    if (editId) tasks = tasks.map(t => t.id === editId ? mapTask(result.data) : t);
    else tasks.push(mapTask(result.data));
    clearForm(); renderEverything();
    toast(editId ? 'Assignment updated ♡' : 'Assignment added! You got this ✿');
  } catch (error) { toast(`Could not save: ${cleanError(error)}`); }
  finally { setBusy(false); }
});
$('cancelEdit').addEventListener('click', clearForm);
$('heroAdd').addEventListener('click', focusTaskForm);
$('assignmentsAdd').addEventListener('click', () => { clearForm(); focusTaskForm(); });
$('taskSearch').addEventListener('input', renderAllTasks);
$('statusFilter').addEventListener('change', renderAllTasks);
$('sortOrder').addEventListener('change', renderAllTasks);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.goto)));
$('prevMonth').addEventListener('click', () => { calendarMonth--; if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; } renderCalendar(); });
$('nextMonth').addEventListener('click', () => { calendarMonth++; if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; } renderCalendar(); });

const initialTheme = localStorage.getItem(STORAGE.theme) === 'dark' ? 'dark' : 'light';
function setTheme(theme) {
  const dark = theme === 'dark'; document.body.classList.toggle('dark', dark);
  $('themeGlyph').textContent = dark ? '☀' : '☾'; $('themeName').textContent = dark ? 'Light mode' : 'Dark mode';
  $('themeToggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  localStorage.setItem(STORAGE.theme, theme);
}
$('themeToggle').addEventListener('click', () => setTheme(document.body.classList.contains('dark') ? 'light' : 'dark'));

// Focus timer measures against wall time, so it stays accurate when background tabs are throttled.
let timerMode = 'work';
let secondsRemaining = 25 * 60;
let timerDeadline = 0;
let timerInterval = null;
const duration = (mode) => mode === 'work' ? 25 * 60 : 5 * 60;
function renderTimer() {
  const time = `${pad(Math.floor(secondsRemaining / 60))}:${pad(secondsRemaining % 60)}`;
  $('timerDisplay').textContent = time; $('smallTimer').textContent = time;
  $('timerStart').textContent = timerInterval ? '❚❚ Pause' : '▶ Start focus';
  $('sessionCount').textContent = sessionCount;
}
function pauseTimer() {
  if (!timerInterval) return;
  secondsRemaining = Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000));
  clearInterval(timerInterval); timerInterval = null; renderTimer();
}
function timerTick() {
  secondsRemaining = Math.max(0, Math.ceil((timerDeadline - Date.now()) / 1000)); renderTimer();
  if (secondsRemaining <= 0) {
    clearInterval(timerInterval); timerInterval = null;
    if (timerMode === 'work') { sessionCount++; localStorage.setItem(sessionKey(guestMode ? 'guest' : currentUser.id), String(sessionCount)); $('timerMessage').textContent = 'You did it! Take a little break ♡'; }
    else $('timerMessage').textContent = 'Break over! Ready for another round? ✿';
    secondsRemaining = duration(timerMode); renderTimer(); toast('Timer finished! ✨');
  }
}
$('timerStart').addEventListener('click', () => {
  if (timerInterval) { pauseTimer(); $('timerMessage').textContent = 'Paused. Your progress is still progress ♡'; return; }
  timerDeadline = Date.now() + secondsRemaining * 1000;
  timerInterval = setInterval(timerTick, 250); $('timerMessage').textContent = timerMode === 'work' ? 'Focus on one thing at a time. You can do it!' : 'Stretch, hydrate, and take a breather ♡'; renderTimer();
});
$('timerReset').addEventListener('click', () => { pauseTimer(); secondsRemaining = duration(timerMode); $('timerMessage').textContent = 'Fresh start, fresh energy! ✿'; renderTimer(); });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.mode === timerMode) return;
  pauseTimer(); timerMode = button.dataset.mode; secondsRemaining = duration(timerMode);
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('active', item.dataset.mode === timerMode));
  $('timerMessage').textContent = timerMode === 'work' ? 'Time to focus. You got this! ✿' : 'Enjoy your well-earned break ♡'; renderTimer();
}));

$('todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
setTheme(initialTheme);
$('taskDue').value = todayYMD();
renderEverything();
renderTimer();
changeView('dashboard');
void initializeAuth();
