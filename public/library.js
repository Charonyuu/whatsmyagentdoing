(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('libraryDialog');
  const launch = $('libraryOpen');
  const publicLaunch = $('libraryPublicOpen');
  const close = $('libraryClose');
  const room = $('libraryRoom');
  const booksView = $('libraryBooks');
  const skillView = $('librarySkill');
  const status = $('libraryStatus');
  const statusText = $('libraryStatusText');
  const retry = $('libraryRetry');
  const desks = $('libraryDesks');
  const bookList = $('libraryBookList');
  const bookStage = $('libraryBookStage');
  const dropZone = $('libraryDropZone');
  const search = $('librarySearch');
  const booksStatus = $('libraryBooksStatus');
  const booksStatusText = $('libraryBooksStatusText');
  const retryBooks = $('libraryRetryBooks');
  const skillStatus = $('librarySkillStatus');
  const skillStatusText = $('librarySkillStatusText');
  const retrySkill = $('libraryRetrySkill');

  const localLibraryDisabled = document.body?.dataset.localLibraryDisabled === 'true';
  if (localLibraryDisabled && launch) launch.hidden = true;
  if (!dialog || !launch || !publicLaunch || !bookStage || !dropZone || !$('libraryReaderStage')) return;

  const copy = {
    zh: {
      open: '技能图书馆', title: '技能图书室', archive: 'MYOFFICE · SKILL LIBRARY',
      intro: '走到一张阅读桌前，翻开它收纳的技能书。', close: '关闭图书馆',
      roomLabel: '技能图书室的阅读桌', desksLabel: '分类阅读桌', roomHint: '选一张桌子，看看上面有哪些书。',
      backRoom: '回到房间', backBooks: '回到技能书', searchLabel: '查找技能书', searchPlaceholder: '输入技能名称或关键词',
      count: (n) => `${n} 本技能书`, books: (n) => `${n} 本`,
      readingMat: '阅读垫', dragBook: '把书拖到这里，或直接点开', dragTouch: '抓住封面右上角的把手拖到这里', dropBook: '松手打开这本书',
      loadingLibrary: '正在整理书桌……', loadingSkill: '正在打开这本技能书……',
      loadError: '暂时无法读取技能目录，请检查连接后重试。', skillError: '暂时无法打开这本技能书，请重试。',
      retry: '重试', noCategories: '这里还没有技能分类。', noBooks: '这张桌子上还没有技能书。',
      noMatches: '没有找到匹配的技能书。', noInstructions: '暂无技能说明正文。',
      sources: '来源', instructions: '技能说明', unknownCategory: '其他技能',
      category: {
        development: ['开发', '编码、调试与代码审查'],
        design: ['设计', '界面、视觉与交互设计'],
        media: ['媒体', '图像、音频与视频制作'],
        writing: ['写作', '文案、编辑与内容表达'],
        research: ['研究', '资料检索、核验与分析'],
        productivity: ['效率', '日常工作流与工具使用'],
        games: ['游戏', '游戏制作与互动体验'],
        other: ['其他', '跨领域与专用技能'],
      },
    },
    en: {
      open: 'Skill library', title: 'Skill reading room', archive: 'MYOFFICE · SKILL LIBRARY',
      intro: 'Choose a reading desk, then open one of its skill books.', close: 'Close skill library',
      roomLabel: 'Reading desks in the skill library', desksLabel: 'Skill category desks', roomHint: 'Choose a desk to see its books.',
      backRoom: 'Back to room', backBooks: 'Back to books', searchLabel: 'Find a skill book', searchPlaceholder: 'Search skills or keywords',
      count: (n) => `${n} skill books`, books: (n) => `${n} books`,
      readingMat: 'Reading mat', dragBook: 'Drop a book here, or click its cover', dragTouch: 'Drag a book here by its handle', dropBook: 'Release to open this book',
      loadingLibrary: 'Setting the reading desks…', loadingSkill: 'Opening this skill book…',
      loadError: 'The skill directory could not be loaded. Check your connection and try again.',
      skillError: 'This skill book could not be opened. Please try again.',
      retry: 'Retry', noCategories: 'There are no skill categories yet.', noBooks: 'This desk has no books yet.',
      noMatches: 'No matching skill books found.', noInstructions: 'No instruction text is available.',
      sources: 'Sources', instructions: 'Skill instructions', unknownCategory: 'Other skills',
      category: {
        development: ['Development', 'Coding, debugging, and code review'],
        design: ['Design', 'Interface, visual, and interaction design'],
        media: ['Media', 'Image, audio, and video production'],
        writing: ['Writing', 'Copy, editing, and content craft'],
        research: ['Research', 'Search, source checks, and analysis'],
        productivity: ['Productivity', 'Everyday workflows and tools'],
        games: ['Games', 'Game creation and interactive experiences'],
        other: ['Other', 'Cross-disciplinary and specialist skills'],
      },
    },
  };
  const order = ['development', 'design', 'media', 'writing', 'research', 'productivity', 'games', 'other'];
  const isChinese = () => /^zh(?:-|$)/i.test(document.documentElement.lang || '');
  const local = () => isChinese() ? copy.zh : copy.en;
  const publicCopy = {
    zh: {
      title: '公共图书馆', intro: '来热门桌找新书，或按用途选一张桌子。',
      trending: '近期热门', trendingDesc: '从 skills.sh 趋势榜选书，保留上榜名次。',
      recommended: '馆员推荐', overview: '馆藏笔记', use: '这本书能做什么', card: '收录记录',
      listLink: 'skills.sh 趋势榜 ↗', sourceLink: '打开原始条目 ↗',
      date: (date, atlas) => `榜单快照 ${date} · Atlas 分类参考 ${atlas}`,
      rank: (rank) => `趋势榜第 ${rank} 名`,
      rankedNote: (rank, date) => `skills.sh 趋势榜第 ${rank} 名，采集于 ${date}。`,
      pickNote: (date) => `来自 Vibe Atlas 的设计技能目录（${date}）。`,
    },
    en: {
      title: 'Public library', intro: 'Visit the Trending desk for new finds, or pick a desk by task.',
      trending: 'Trending', trendingDesc: 'A selection from skills.sh Trending, in its original rank order.',
      recommended: 'Staff pick', overview: 'Catalog notes', use: 'What this skill does', card: 'Catalog record',
      listLink: 'skills.sh Trending ↗', sourceLink: 'Open original listing ↗',
      date: (date, atlas) => `Ranking snapshot ${date} · Atlas categories ${atlas}`,
      rank: (rank) => `Trending #${rank}`,
      rankedNote: (rank, date) => `#${rank} on skills.sh Trending, captured ${date}.`,
      pickNote: (date) => `From the Vibe Atlas design skills catalog (${date}).`,
    },
  };
  const publicText = () => isChinese() ? publicCopy.zh : publicCopy.en;
  let publicRoom = false;
  let publicCatalog = null;
  let categories = [];
  let category = null;
  let currentBooks = [];
  let activeSkillId = null;
  let originDesk = null;
  let originBook = null;
  let requestNumber = 0;
  let controller = null;
  let lastFocus = null;
  let drag = null;
  let skippedClick = null;

  const coverArt = {
    development: '<rect x="11" y="15" width="52" height="39" rx="6" fill="#ffdf9d" transform="rotate(-6 37 34)"/><rect x="15" y="13" width="48" height="35" rx="5" fill="#203949" stroke="#ffe3a6" stroke-width="2"/><path d="m25 25 8 5-8 5m14 0h12" fill="none" stroke="#a8d9ba" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 52h14m-7-4v4" stroke="#ffe3a6" stroke-width="3" stroke-linecap="round"/>',
    design: '<path d="M64 34c0 16-14 23-25 20-7-2-2-9-8-11-6-2-9 6-16 2-11-7-4-25 8-31 20-11 42 4 41 20Z" fill="#ffdf9d" stroke="#573d32" stroke-width="2"/><circle cx="25" cy="23" r="5" fill="#dd806c"/><circle cx="41" cy="20" r="5" fill="#77b5a1"/><circle cx="53" cy="30" r="5" fill="#8aa0d3"/><path d="m33 40 15 15" stroke="#6c4a3d" stroke-width="6" stroke-linecap="round"/><path d="m48 55 4 4" stroke="#f4bf78" stroke-width="6" stroke-linecap="round"/>',
    media: '<rect x="12" y="24" width="48" height="30" rx="4" fill="#ffd68e" stroke="#41334a" stroke-width="2"/><path d="m12 25 47-9-2-10-47 10Z" fill="#4a4867" stroke="#ffe8b8" stroke-width="2"/><path d="m18 15 8 9m7-12 8 8m7-12 8 8" stroke="#ffe8b8" stroke-width="3"/><path d="m32 32 12 7-12 7Z" fill="#935969"/>',
    writing: '<path d="M17 12h33l7 8v36H17Z" fill="#ffdf9d" stroke="#604339" stroke-width="2"/><path d="M49 12v10h8M23 47h24m-24 5h16" stroke="#b68a61" stroke-width="2" fill="none"/><path d="M30 44c7-17 17-28 31-27-1 12-8 21-22 22Z" fill="#80b5a1" stroke="#385d56" stroke-width="2"/><path d="m25 48 26-22" stroke="#385d56" stroke-width="2" stroke-linecap="round"/>',
    research: '<rect x="11" y="13" width="43" height="41" rx="4" fill="#ffe1a4" stroke="#544433" stroke-width="2" transform="rotate(-7 32 34)"/><path d="M19 44l8-12 8 6 11-17" stroke="#699a8b" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="46" cy="30" r="12" fill="#9fcac0" fill-opacity=".65" stroke="#433b43" stroke-width="4"/><path d="m55 39 11 12" stroke="#433b43" stroke-width="7" stroke-linecap="round"/>',
    productivity: '<rect x="12" y="16" width="43" height="37" rx="5" fill="#ffe1a4" stroke="#60463e" stroke-width="2"/><path d="M12 27h43M23 12v10m21-10v10" stroke="#ba7a63" stroke-width="4" stroke-linecap="round"/><path d="m22 37 4 4 7-8" fill="none" stroke="#679c85" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="51" cy="44" r="13" fill="#9bc7bb" stroke="#3c5a56" stroke-width="2"/><path d="M51 37v8l5 3" fill="none" stroke="#3c5a56" stroke-width="2.5" stroke-linecap="round"/>',
    games: '<path d="M22 20h30c7 0 10 8 13 20 2 8-5 13-11 8l-9-8H28l-8 8c-6 5-13 0-11-8 3-12 6-20 13-20Z" fill="#ffde9d" stroke="#4d3948" stroke-width="2.5"/><path d="M23 27v11m-6-5h12" stroke="#5b567e" stroke-width="3" stroke-linecap="round"/><circle cx="49" cy="31" r="3" fill="#a85d69"/><circle cx="56" cy="36" r="3" fill="#639b88"/><path d="M36 20v-5c0-4 6-3 6-7" fill="none" stroke="#ffde9d" stroke-width="2" stroke-linecap="round"/>',
    other: '<path d="m13 32 27-12 23 10-27 12Z" fill="#91b9a6" stroke="#51483e" stroke-width="2"/><path d="M13 32v9l23 11 27-12v-10L36 42Z" fill="#ffe1a4" stroke="#51483e" stroke-width="2"/><path d="m16 45 20 10 24-11" fill="none" stroke="#e7ad74" stroke-width="4" stroke-linecap="round"/><path d="m45 6 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" fill="#ffde9d" stroke="#746244" stroke-width="1.4"/>',
  };

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function localized(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      return value[document.documentElement.lang] || value[document.documentElement.lang?.split('-')[0]] || value.en || value.zh || '';
    }
    return '';
  }

  let readerSections = [];
  let readerIndex = 0;
  let readerRaw = false;
  let readerBody = '';

  function readerCopy() {
    return isChinese()
      ? { opening: '开篇', contents: '本书目录', previous: '上一章', next: '下一章', text: '原文', formatted: '排版', empty: local().noInstructions, folio: (n, count) => `第 ${n} / ${count} 章`, progress: (n, count) => `${String(n).padStart(2, '0')} / ${String(count).padStart(2, '0')}` }
      : { opening: 'Opening', contents: 'Contents', previous: 'Previous', next: 'Next', text: 'Raw text', formatted: 'Reader view', empty: local().noInstructions, folio: (n, count) => `Chapter ${n} of ${count}`, progress: (n, count) => `${String(n).padStart(2, '0')} / ${String(count).padStart(2, '0')}` };
  }

  function readInline(parent, text) {
    const pattern = /(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
    let offset = 0;
    for (const match of String(text).matchAll(pattern)) {
      if (match.index > offset) parent.append(document.createTextNode(text.slice(offset, match.index)));
      const token = match[0];
      let node;
      if (token.startsWith('[')) {
        const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        if (link) {
          node = document.createElement('a');
          node.href = link[2];
          node.rel = 'noopener noreferrer';
          node.target = '_blank';
          node.textContent = link[1];
        }
      } else if (token.startsWith('`')) {
        node = document.createElement('code');
        node.textContent = token.slice(1, -1);
      } else if (token.startsWith('**') || token.startsWith('__')) {
        node = document.createElement('strong');
        node.textContent = token.slice(2, -2);
      } else {
        node = document.createElement('em');
        node.textContent = token.slice(1, -1);
      }
      parent.append(node || document.createTextNode(token));
      offset = match.index + token.length;
    }
    if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
  }

  function markdownBlocks(lines) {
    const root = document.createDocumentFragment();
    let paragraph = [];
    const flush = () => {
      if (!paragraph.length) return;
      const p = document.createElement('p');
      paragraph.forEach((line, index) => { if (index) p.append(document.createElement('br')); readInline(p, line); });
      root.append(p);
      paragraph = [];
    };
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { flush(); i += 1; continue; }
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        flush();
        const marker = fence[1];
        const codeLines = [];
        i += 1;
        const closing = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`);
        while (i < lines.length && !closing.test(lines[i])) codeLines.push(lines[i++]);
        if (i < lines.length) i += 1;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const language = fence[2].trim().split(/\s+/, 1)[0];
        if (/^[a-z\d_+-]{1,24}$/i.test(language)) code.className = `language-${language}`;
        code.textContent = codeLines.join('\n');
        pre.append(code);
        root.append(pre);
        continue;
      }
      const heading = line.match(/^ {0,3}(#{4,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flush();
        const h = document.createElement(`h${Math.max(5, heading[1].length)}`);
        readInline(h, heading[2]);
        root.append(h);
        i += 1;
        continue;
      }
      const list = line.match(/^\s*([-*+] |\d+[.)] )(.*)$/);
      if (list) {
        flush();
        const ordered = /^\d/.test(list[1]);
        const listNode = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const item = lines[i].match(/^\s*([-*+] |\d+[.)] )(.*)$/);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          const li = document.createElement('li');
          readInline(li, item[2]);
          listNode.append(li);
          i += 1;
        }
        root.append(listNode);
        continue;
      }
      if (/^\s*> ?/.test(line)) {
        flush();
        const quoteLines = [];
        while (i < lines.length && /^\s*> ?/.test(lines[i])) quoteLines.push(lines[i++].replace(/^\s*> ?/, ''));
        const quote = document.createElement('blockquote');
        const p = document.createElement('p');
        quoteLines.forEach((quoteLine, index) => { if (index) p.append(document.createElement('br')); readInline(p, quoteLine); });
        quote.append(p);
        root.append(quote);
        continue;
      }
      if (/^\s*([-*_]\s*){3,}$/.test(line)) { flush(); root.append(document.createElement('hr')); i += 1; continue; }
      paragraph.push(line.trimEnd());
      i += 1;
    }
    flush();
    return root;
  }

  function parseReaderSections(body) {
    const lines = String(body || '').split(/\r?\n/);
    const sections = [];
    let title = '';
    let content = [];
    let fence = null;
    const flush = () => {
      if (content.some((line) => line.trim())) sections.push({ title: title || null, lines: content });
      title = '';
      content = [];
    };
    for (const line of lines) {
      if (fence) {
        if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
        content.push(line);
        continue;
      }
      const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceLine) {
        const marker = fenceLine[1];
        fence = { char: marker[0], length: marker.length };
        content.push(line);
        continue;
      }
      const heading = line.match(/^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flush();
        title = heading[2].replace(/[*_`]/g, '').trim();
      } else content.push(line);
    }
    flush();
    if (!sections.length) sections.push({ title: null, lines: [] });
    return sections;
  }

  function turnReader(direction, focus = true) {
    if (!readerSections.length || readerRaw) return;
    const next = readerIndex + direction;
    if (next < 0 || next >= readerSections.length) return;
    readerIndex = next;
    renderReaderPage(direction > 0 ? 'forward' : 'back');
    if (focus) $('libraryReaderChapterTitle')?.focus();
  }

  function renderReaderPage(turn = '') {
    const t = readerCopy();
    const prose = $('libraryReaderProse');
    const page = document.querySelector('.library-reader-page');
    if (!prose || !page || !readerSections.length) return;
    const section = readerSections[readerIndex];
    setText('libraryReaderChapterTitle', section.title || t.opening);
    prose.replaceChildren(markdownBlocks(section.lines));
    if (!prose.childElementCount) prose.textContent = t.empty;
    $('libraryReaderPageContent').scrollTop = 0;
    setText('libraryReaderFolios', t.folio(readerIndex + 1, readerSections.length));
    setText('libraryReaderProgress', t.progress(readerIndex + 1, readerSections.length));
    $('libraryReaderPrev').disabled = readerIndex <= 0;
    $('libraryReaderNext').disabled = readerIndex >= readerSections.length - 1;
    page.dataset.turn = '';
    if (turn) {
      void page.offsetWidth;
      page.dataset.turn = turn;
    }
    const chapters = $('libraryReaderChapters');
    Array.from(chapters.children).forEach((li, index) => {
      const button = li.querySelector('button');
      if (index === readerIndex) button?.setAttribute('aria-current', 'page');
      else button?.removeAttribute('aria-current');
    });
  }

  function renderReaderToc() {
    const chapters = $('libraryReaderChapters');
    if (!chapters) return;
    const fragment = document.createDocumentFragment();
    readerSections.forEach((section, index) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.chapterIndex = String(index);
      button.textContent = section.title || readerCopy().opening;
      li.append(button);
      fragment.append(li);
    });
    chapters.replaceChildren(fragment);
    setText('libraryReaderTocLabel', `${readerCopy().contents} · ${readerSections.length}`);
  }

  function updateReaderLabels() {
    const t = readerCopy();
    setText('libraryReaderPrevLabel', t.previous);
    setText('libraryReaderNextLabel', t.next);
    const mode = $('libraryReaderMode');
    if (mode) mode.textContent = readerRaw ? t.formatted : t.text;
    setText('libraryReaderTocLabel', `${t.contents} · ${readerSections.length || 0}`);
    if (readerRaw) $('librarySkillBody').textContent = readerBody || t.empty;
    else if (readerSections.length) renderReaderPage();
  }

  function setReaderMode(raw) {
    readerRaw = raw;
    $('libraryReaderPageContent').hidden = raw;
    $('libraryReaderFooter').hidden = raw;
    $('libraryReaderFolios').hidden = raw;
    $('libraryReaderToc').hidden = raw;
    $('librarySkillBody').hidden = !raw;
  }

  function resetReader() {
    readerSections = [];
    readerIndex = 0;
    readerRaw = false;
    readerBody = '';
    $('libraryReaderStage').hidden = true;
    $('libraryReaderMode').hidden = true;
    setReaderMode(false);
    $('librarySkillBody').textContent = '';
    $('libraryReaderToc').open = false;
    $('libraryReaderChapters').replaceChildren();
  }

  function showReader(body) {
    readerBody = typeof body === 'string' ? body : '';
    readerSections = parseReaderSections(readerBody);
    readerIndex = 0;
    $('librarySkillBody').textContent = readerBody || readerCopy().empty;
    setReaderMode(false);
    $('libraryReaderToc').open = !window.matchMedia('(max-width: 720px)').matches;
    $('libraryReaderStage').hidden = false;
    $('libraryReaderMode').hidden = publicRoom;
    renderReaderToc();
    updateReaderLabels();
  }

  function bindReader() {
    $('libraryReaderPrev')?.addEventListener('click', () => turnReader(-1));
    $('libraryReaderNext')?.addEventListener('click', () => turnReader(1));
    $('libraryReaderChapters')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-chapter-index]');
      if (!button) return;
      const index = Number(button.dataset.chapterIndex);
      if (!Number.isInteger(index) || index < 0 || index >= readerSections.length) return;
      const previous = Number($('libraryReaderChapters').querySelector('[aria-current="page"]')?.dataset.chapterIndex ?? readerIndex);
      readerIndex = index;
      renderReaderPage(index === previous ? '' : index > previous ? 'forward' : 'back');
      $('libraryReaderToc').open = !window.matchMedia('(max-width: 720px)').matches;
      $('libraryReaderChapterTitle')?.focus();
    });
    $('libraryReaderMode')?.addEventListener('click', () => {
      setReaderMode(!readerRaw);
      updateReaderLabels();
    });
    skillView?.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowRight' && !readerRaw) { event.preventDefault(); turnReader(1); }
      if (event.key === 'ArrowLeft' && !readerRaw) { event.preventDefault(); turnReader(-1); }
    });
    document.querySelector('.library-reader-page')?.addEventListener('animationend', (event) => {
      if (event.animationName.startsWith('library-page-')) event.currentTarget.dataset.turn = '';
    });
  }

  function categoryInfo(item) {
    if (item?.id === 'public-trending') return { name: publicText().trending, description: publicText().trendingDesc };
    const words = publicRoom ? null : local().category[item?.id];
    const name = words?.[0] || localized(item?.name) || item?.id || local().unknownCategory;
    const description = words?.[1] || localized(item?.description) || '';
    return { name, description };
  }

  function textOfSkill(item, field) { return localized(item?.[field]); }
  function skillId(item) { return typeof item?.id === 'string' || typeof item?.id === 'number' ? String(item.id) : ''; }

  function updatePublicNote() {
    const p = publicText();
    $('libraryPublicNote').hidden = !publicRoom;
    setText('libraryPublicDate', publicCatalog ? p.date(publicCatalog.date, publicCatalog.atlasDate) : '');
    setText('libraryTrendingLink', p.listLink);
  }

  function updateLabels() {
    const t = local();
    const p = publicText();
    setText('libraryOpenLabel', t.open);
    launch.setAttribute('aria-label', t.open);
    setText('libraryPublicOpenLabel', p.title);
    setText('libraryEyebrow', publicRoom ? 'MYOFFICE · PUBLIC COLLECTION' : t.archive);
    setText('libraryTitle', publicRoom ? p.title : t.title);
    setText('libraryIntro', publicRoom ? p.intro : t.intro);
    updatePublicNote();
    close.setAttribute('aria-label', t.close);
    $('libraryRoom')?.setAttribute('aria-label', t.roomLabel);
    desks?.setAttribute('aria-label', t.desksLabel);
    setText('libraryRoomHint', t.roomHint);
    setText('libraryBackRoomLabel', t.backRoom);
    setText('libraryBackBooksLabel', t.backBooks);
    setText('librarySearchLabel', t.searchLabel);
    search?.setAttribute('placeholder', t.searchPlaceholder);
    setText('librarySourcesTitle', t.sources);
    setText('libraryInstructionsTitle', publicRoom ? p.overview : t.instructions);
    setText('libraryRetry', t.retry);
    setText('libraryRetryBooks', t.retry);
    setText('libraryRetrySkill', t.retry);
    setText('libraryMatTitle', t.readingMat);
    updateReaderLabels();
    updateMatHint();
    if (category) renderCategoryHeader();
    if (categories.length && !room.hidden) renderDesks();
    if (category && !booksView.hidden) renderBooks(search?.value || '');
  }

  function setView(name) {
    finishDrag();
    room.hidden = name !== 'room';
    booksView.hidden = name !== 'books';
    skillView.hidden = name !== 'skill';
    $('libraryContent')?.scrollTo(0, 0);
  }

  function cancelPending() {
    requestNumber += 1;
    controller?.abort();
    controller = null;
  }

  function newRequest() {
    controller?.abort();
    controller = new AbortController();
    requestNumber += 1;
    return { number: requestNumber, signal: controller.signal };
  }

  function isCurrent(req) { return req.number === requestNumber && dialog.open; }

  function showLibraryStatus(state, message, canRetry = false) {
    room.hidden = true;
    booksView.hidden = true;
    skillView.hidden = true;
    $('libraryContent')?.scrollTo(0, 0);
    status.hidden = false;
    status.dataset.state = state;
    statusText.textContent = message;
    retry.hidden = !canRetry;
  }

  function hideLibraryStatus() { status.hidden = true; }

  function setInlineStatus(el, textEl, buttonEl, state, message, canRetry = false) {
    el.hidden = false;
    el.dataset.state = state;
    textEl.textContent = message;
    buttonEl.hidden = !canRetry;
  }

  function hideBooksStatus() { booksStatus.hidden = true; }
  function hideSkillStatus() { skillStatus.hidden = true; }

  async function loadCategories(reopenId = '') {
    category = null;
    categories = [];
    currentBooks = [];
    activeSkillId = null;
    desks.replaceChildren();
    bookList.replaceChildren();
    hideBooksStatus();
    hideSkillStatus();
    showLibraryStatus('loading', local().loadingLibrary);
    const req = newRequest();
    try {
      const response = await fetch(publicRoom ? '/assets/public-skills.json' : '/api/library', { signal: req.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!isCurrent(req)) return;
      categories = Array.isArray(data?.categories) ? data.categories.filter((x) => x && typeof x.id === 'string') : [];
      if (publicRoom) {
        publicCatalog = data;
        const ranked = categories.flatMap((group) => group.skills.filter((book) => Number.isInteger(book.rank)).map((book) => ({ ...book, art: group.art })));
        ranked.sort((a, b) => a.rank - b.rank);
        if (ranked.length) categories.unshift({ id: 'public-trending', art: 'other', skills: ranked });
        updatePublicNote();
      } else {
        categories.sort((a, b) => {
          const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
          return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
        });
      }
      hideLibraryStatus();
      if (!categories.length) {
        showLibraryStatus('empty', local().noCategories);
        retry.hidden = true;
        return;
      }
      renderDesks();
      if (reopenId) {
        const found = categories.find((x) => x.id === reopenId);
        if (found) { openCategory(reopenId); return; }
      }
      setView('room');
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrent(req)) return;
      showLibraryStatus('error', local().loadError, true);
    }
  }

  function makeDesk(categoryData) {
    const t = local();
    const info = categoryInfo(categoryData);
    const skills = Array.isArray(categoryData.skills) ? categoryData.skills : [];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'library-desk';
    button.dataset.categoryId = categoryData.id;
    button.dataset.art = categoryData.art || categoryData.id;
    button.setAttribute('aria-label', `${info.name}: ${info.description}. ${t.count(skills.length)}`);
    const art = document.createElement('span');
    art.className = 'desk-art';
    art.setAttribute('aria-hidden', 'true');
    for (const [className, text] of [
      ['desk-shadow', ''], ['desk-leg left', ''], ['desk-leg right', ''], ['desk-top', ''], ['desk-edge', ''],
      ['desk-book one', ''], ['desk-book two', ''], ['desk-lamp', ''],
    ]) {
      const part = document.createElement('span');
      part.className = className;
      if (className === 'desk-lamp') part.append(document.createElement('i'));
      if (text) part.textContent = text;
      art.append(part);
    }
    const copyNode = document.createElement('span');
    copyNode.className = 'desk-copy';
    const name = document.createElement('strong');
    name.textContent = info.name;
    const count = document.createElement('small');
    count.textContent = t.books(skills.length);
    copyNode.append(name, count);
    button.append(art, copyNode);
    return button;
  }

  function renderDesks() {
    desks.replaceChildren(...categories.map(makeDesk));
  }

  function renderCategoryHeader() {
    if (!category) return;
    const info = categoryInfo(category);
    const skills = Array.isArray(category.skills) ? category.skills : [];
    setText('libraryCategoryKicker', local().count(skills.length));
    setText('libraryCategoryTitle', info.name);
    setText('libraryCategoryDescription', info.description);
  }

  function openCategory(id, trigger = null) {
    cancelPending();
    if (trigger) originDesk = trigger;
    category = categories.find((item) => item.id === id) || null;
    if (!category) return;
    currentBooks = Array.isArray(category.skills) ? category.skills.filter((book) => skillId(book)) : [];
    activeSkillId = null;
    hideLibraryStatus();
    hideSkillStatus();
    hideBooksStatus();
    renderCategoryHeader();
    search.value = '';
    renderBooks('');
    setView('books');
    $('libraryCategoryTitle').focus({ preventScroll: true });
  }

  function renderBooks(query) {
    if (!category) return;
    finishDrag();
    const q = String(query || '').trim().toLocaleLowerCase();
    const filtered = currentBooks.filter((book) => `${textOfSkill(book, 'name')} ${textOfSkill(book, 'description')} ${book.id} ${book.source || ''}`.toLocaleLowerCase().includes(q));
    bookList.replaceChildren();
    bookStage.hidden = currentBooks.length === 0;
    bookStage.classList.toggle('is-empty', !filtered.length);
    dropZone.parentElement.hidden = !filtered.length;
    hideBooksStatus();
    if (!currentBooks.length) {
      setInlineStatus(booksStatus, booksStatusText, retryBooks, 'empty', local().noBooks);
      retryBooks.hidden = true;
      return;
    }
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'library-empty';
      empty.textContent = local().noMatches;
      bookList.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    filtered.forEach((book) => {
      const id = skillId(book);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'library-book';
      button.dataset.skillId = id;
      const nameText = textOfSkill(book, 'name') || id;
      const descriptionText = textOfSkill(book, 'description');
      const rankText = publicRoom ? (book.rank ? publicText().rank(book.rank) : publicText().recommended) : '';
      button.title = nameText;
      button.setAttribute('aria-label', [nameText, rankText, descriptionText].filter(Boolean).join('. '));
      const serial = currentBooks.indexOf(book) + 1;
      button.dataset.jacket = String((serial - 1) % 6);
      const cover = document.createElement('span');
      cover.className = 'library-book-cover';
      cover.setAttribute('aria-hidden', 'true');
      const edition = document.createElement('span');
      edition.className = 'library-book-edition';
      edition.textContent = categoryInfo(category).name;
      cover.append(edition);
      const artId = book.art || category.art || category.id;
      const art = Object.hasOwn(coverArt, artId) ? coverArt[artId] : coverArt.other;
      cover.insertAdjacentHTML('beforeend', `<svg class="library-book-emblem" viewBox="0 0 74 64" aria-hidden="true">${art}</svg>`);
      const name = document.createElement('strong');
      name.className = 'library-book-title';
      name.textContent = nameText;
      const number = document.createElement('span');
      number.className = 'library-book-serial';
      number.textContent = publicRoom ? (book.rank ? `# ${book.rank}` : publicText().recommended) : `№ ${String(serial).padStart(2, '0')}`;
      cover.append(name, number);
      const grip = document.createElement('span');
      grip.className = 'library-book-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.append(document.createElement('span'));
      button.append(cover, grip);
      fragment.append(button);
    });
    bookList.append(fragment);
  }

  function updateMatHint(over = false) {
    const t = local();
    setText('libraryMatHint', over ? t.dropBook : matchMedia('(pointer: coarse)').matches ? t.dragTouch : t.dragBook);
  }

  function isOverMat(event) {
    return dropZone.contains(document.elementFromPoint(event.clientX, event.clientY));
  }

  function finishDrag() {
    if (!drag) return;
    const { book, pointerId, follower } = drag;
    drag = null;
    if (book.hasPointerCapture(pointerId)) book.releasePointerCapture(pointerId);
    if (!follower) return;
    follower.remove();
    book.classList.remove('is-carried');
    dropZone.classList.remove('is-armed', 'is-targeted');
    updateMatHint();
  }

  dialog.addEventListener('pointerdown', (event) => {
    if (event.isPrimary && event.button === 0 && !drag) skippedClick = null;
  }, { capture: true });

  bookList.addEventListener('pointerdown', (event) => {
    const book = event.target.closest('.library-book');
    if (!book || !event.isPrimary || event.button !== 0 || drag) return;
    if (event.pointerType !== 'mouse' && !event.target.closest('.library-book-grip')) return;
    const rect = book.getBoundingClientRect();
    drag = { book, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, follower: null, over: false };
    book.setPointerCapture(event.pointerId);
  });

  dialog.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const { book, rect, x, y } = drag;
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    if (!drag.follower) {
      if (Math.hypot(dx, dy) < 7) return;
      const follower = book.cloneNode(true);
      follower.classList.add('library-carried-book');
      follower.removeAttribute('data-skill-id');
      follower.removeAttribute('title');
      follower.setAttribute('aria-hidden', 'true');
      follower.inert = true;
      follower.style.width = `${rect.width}px`;
      follower.style.height = `${rect.height}px`;
      const cue = document.createElement('span');
      cue.className = 'library-book-drop-cue';
      cue.textContent = local().dropBook;
      follower.append(cue);
      drag.follower = follower;
      dialog.append(follower);
      book.classList.add('is-carried');
      dropZone.classList.add('is-armed');
      skippedClick = book;
    }
    const over = isOverMat(event);
    if (over !== drag.over) {
      drag.over = over;
      dropZone.classList.toggle('is-targeted', over);
      drag.follower.classList.toggle('is-over-mat', over);
      updateMatHint(over);
    }
    drag.follower.style.transform = `translate3d(${rect.left + dx}px, ${rect.top + dy - 5}px, 0) rotate(-7deg)`;
  });

  dialog.addEventListener('pointerup', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const { book, follower } = drag;
    const landed = follower && isOverMat(event);
    finishDrag();
    if (landed) openSkill(book.dataset.skillId, book);
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    dialog.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) finishDrag();
    });
  }

  function showSkillStatus(state, message, canRetry = false) {
    setInlineStatus(skillStatus, skillStatusText, retrySkill, state, message, canRetry);
  }

  function appendSource(list, label, href) {
    const li = document.createElement('li');
    let url;
    if (href) {
      try { url = new URL(href); } catch { /* Show an invalid source as text. */ }
    }
    if (url?.protocol === 'https:' && ['skills.sh', 'www.skills.sh', 'github.com'].includes(url.hostname) && !url.username && !url.password) {
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = label;
      li.append(link);
    } else {
      li.textContent = label;
    }
    list.append(li);
  }

  function renderSkill(data) {
    const item = data?.skill;
    if (!item || String(item.id) !== activeSkillId) throw new Error('Skill response did not match the requested ID.');
    hideSkillStatus();
    const p = publicText();
    const rankText = publicRoom ? (item.rank ? p.rank(item.rank) : p.recommended) : local().instructions;
    setText('librarySkillKicker', `${categoryInfo(category).name} · ${rankText}`);
    setText('librarySkillTitle', textOfSkill(item, 'name') || activeSkillId);
    setText('librarySkillDescription', textOfSkill(item, 'description'));
    $('librarySkillDescription').hidden = publicRoom;
    const sourcesRoot = $('librarySources');
    const sourceList = $('librarySourceList');
    sourceList.replaceChildren();
    let body = typeof item.body === 'string' ? item.body : '';
    if (publicRoom) {
      appendSource(sourceList, `${item.source} · ${p.sourceLink}`, item.url);
      const note = item.rank ? p.rankedNote(item.rank, publicCatalog.date) : p.pickNote(publicCatalog.atlasDate);
      body = `## ${p.use}\n\n${textOfSkill(item, 'description')}\n\n## ${p.card}\n\n${note}`;
    } else if (Array.isArray(item.sources)) {
      item.sources.filter((source) => typeof source === 'string').forEach((source) => appendSource(sourceList, source));
    }
    sourcesRoot.hidden = !sourceList.childElementCount;
    showReader(body);
    $('librarySkillTitle').focus({ preventScroll: true });
  }

  async function openSkill(id, trigger = null) {
    const book = currentBooks.find((item) => skillId(item) === id);
    if (!book || !category) return;
    if (trigger) originBook = trigger;
    activeSkillId = id;
    hideLibraryStatus();
    hideBooksStatus();
    hideSkillStatus();
    setView('skill');
    resetReader();
    if (publicRoom) {
      cancelPending();
      renderSkill({ skill: book });
      return;
    }
    showSkillStatus('loading', local().loadingSkill);
    skillStatus.focus({ preventScroll: true });
    const req = newRequest();
    try {
      const response = await fetch(`/api/library/skill?id=${encodeURIComponent(id)}`, { signal: req.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!isCurrent(req)) return;
      renderSkill(data);
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrent(req)) return;
      showSkillStatus('error', local().skillError, true);
    }
  }

  function backToRoom() {
    cancelPending();
    activeSkillId = null;
    hideLibraryStatus();
    hideBooksStatus();
    hideSkillStatus();
    setView('room');
    const id = originDesk?.dataset.categoryId;
    const target = originDesk?.isConnected ? originDesk : Array.from(desks.querySelectorAll('[data-category-id]')).find((button) => button.dataset.categoryId === id);
    (target || desks.querySelector('button'))?.focus();
  }

  function backToBooks() {
    cancelPending();
    activeSkillId = null;
    hideLibraryStatus();
    hideSkillStatus();
    setView('books');
    const id = originBook?.dataset.skillId;
    const target = originBook?.isConnected ? originBook : Array.from(bookList.querySelectorAll('[data-skill-id]')).find((button) => button.dataset.skillId === id);
    (target || $('libraryCategoryTitle'))?.focus();
  }

  function openLibrary(usePublicRoom, trigger) {
    lastFocus = trigger;
    publicRoom = usePublicRoom;
    publicCatalog = null;
    originDesk = null;
    originBook = null;
    dialog.classList.toggle('is-public-library', publicRoom);
    if (!dialog.open) dialog.showModal();
    updateLabels();
    loadCategories();
  }

  if (!localLibraryDisabled) launch.addEventListener('click', () => openLibrary(false, launch));
  publicLaunch.addEventListener('click', () => openLibrary(true, publicLaunch));
  close.addEventListener('click', () => dialog.close());
  retry.addEventListener('click', () => loadCategories());
  retryBooks.addEventListener('click', () => loadCategories(category?.id || ''));
  retrySkill.addEventListener('click', () => activeSkillId && openSkill(activeSkillId));
  $('libraryBackRoom').addEventListener('click', backToRoom);
  $('libraryBackBooks').addEventListener('click', backToBooks);
  desks.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category-id]');
    if (button) openCategory(button.dataset.categoryId, button);
  });
  bookList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-skill-id]');
    if (!button) return;
    if (event.detail > 0 && button === skippedClick) {
      skippedClick = null;
      return;
    }
    openSkill(button.dataset.skillId, button);
  });
  search.addEventListener('input', () => renderBooks(search.value));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    if (event.detail > 0 && skippedClick) {
      skippedClick = null;
      return;
    }
    dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (drag?.follower) {
      event.preventDefault();
      finishDrag();
    }
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    cancelPending();
    category = null;
    currentBooks = [];
    activeSkillId = null;
    resetReader();
    setView('room');
    hideLibraryStatus();
    hideBooksStatus();
    hideSkillStatus();
    if (publicRoom && location.hash === '#public-library') {
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
  });
  bindReader();
  new MutationObserver(updateLabels).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  updateLabels();
  function openPublicLink() {
    if (location.hash === '#public-library' && (!dialog.open || !publicRoom)) openLibrary(true, publicLaunch);
  }
  window.addEventListener('hashchange', openPublicLink);
  openPublicLink();
})();
