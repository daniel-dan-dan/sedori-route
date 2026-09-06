// Amazon価格管理。提案の閲覧と見直し設定のみ。価格変更・オフライン再送は行わない。
const AmazonPricing = (() => {
  const CACHE_KEY = 'amazon-pricing-snapshot-v1';
  const PENDING_KEY = 'amazon-pricing-preference-pending-v1';
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const PAGE_SIZE = 50;
  const PROPOSAL_STATES = new Set(['lower', 'raise', 'hold', 'keep']);
  const CONFIRMED_REJECTIONS = new Set(['INVALID_INPUT', 'PRICING_REFRESH_REQUIRED', 'PRICING_REVISION_CONFLICT', 'BUSY', 'UNAUTHORIZED']);
  const SCOPE_LABEL = '在庫管理シートの未販売Amazon SKU（未紐付のAmazon出品は含みません）';
  const LABELS = Object.freeze({ lower: '値下げを検討', raise: '値上げを検討', hold: '価格を維持', keep: '価格を維持', collecting: '情報を確認中', review: '情報の確認が必要', blocked: '情報の確認が必要', exclude: '対象外', excluded: '対象外', snoozed: '様子見中' });
  let activeSession = 0;
  let disposeActive = () => {};

  function text(value, max = 1500) { return value == null ? '' : String(value).slice(0, max); }
  function number(value) {
    if (value == null || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean' || !['number', 'string'].includes(typeof value)) return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  function money(value) { const n = number(value); return n === null ? '未確認' : `${n < 0 ? '−' : ''}¥${Math.abs(n).toLocaleString('ja-JP', { maximumFractionDigits: 0 })}`; }
  function time(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '未確認';
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }
  function isStale(snapshot, now = Date.now()) {
    const date = Date.parse(snapshot?.generatedAt || '');
    return !Number.isFinite(date) || now - date >= MAX_AGE_MS || date > now + 5 * 60 * 1000;
  }
  function proposalValid(item, now = Date.now()) {
    if (!PROPOSAL_STATES.has(item.status)) return true;
    const until = Date.parse(item.validUntil || '');
    return Number.isFinite(until) && now < until;
  }
  function factFresh(at, now = Date.now()) {
    const date = Date.parse(at || '');
    return Number.isFinite(date) && date <= now && now - date < MAX_AGE_MS;
  }
  function quantityCurrent(item, now = Date.now()) {
    return Number.isSafeInteger(item.quantity) && item.quantity >= 0 && !item.quantityReferenceOnly && factFresh(item.quantityObservedAt, now);
  }
  function conditionLabel(value) {
    const labels = { new_new: '新品', new: '新品', used_like_new: '中古・ほぼ新品', used_very_good: '中古・非常に良い', used_good: '中古・良い', used_acceptable: '中古・可', refurbished_refurbished: '再生品', refurbished: '再生品', collectible_like_new: 'コレクター商品・ほぼ新品', collectible_very_good: 'コレクター商品・非常に良い', collectible_good: 'コレクター商品・良い', collectible_acceptable: 'コレクター商品・可' };
    const normalized = text(value, 80).trim();
    return Object.hasOwn(labels, normalized.toLowerCase()) ? labels[normalized.toLowerCase()] : normalized || '未確認';
  }
  function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object' || !text(raw.sku).trim()) throw new Error('商品のSKUを確認できません。最新データを読み直してください。');
    const status = text(raw.status || raw.decision || 'review', 40);
    const preference = raw.preference || {};
    const revision = number(preference.revision);
    return {
      sku: text(raw.sku, 300), asin: text(raw.asin, 30), title: text(raw.title, 500) || '商品名未確認',
      currentPrice: number(raw.currentPrice), suggestedPrice: number(raw.suggestedPrice),
      estimatedProfit: number(raw.estimatedProfit), estimatedMargin: number(raw.estimatedMargin),
      minPrice: number(raw.minPrice ?? raw.floorPrice), availableDays: number(raw.availableDays),
      quantity: number(raw.quantity ?? raw.availableQuantity ?? raw.lastKnownQuantity),
      quantityObservedAt: text(raw.quantityObservedAt || raw.availableQuantityObservedAt || raw.lastQuantityObservedAt, 80),
      quantityReferenceOnly: raw.quantityReferenceOnly === true || (raw.availableQuantity === null && raw.lastKnownQuantity != null),
      additionalCost: number(raw.additionalCost), condition: text(raw.condition, 80), fulfillment: text(raw.fulfillment, 80),
      reasons: Array.isArray(raw.reasons) ? raw.reasons.map(value => text(value)).filter(Boolean) : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings.map(value => text(value)).filter(Boolean) : [],
      nextReviewAt: text(raw.nextReviewAt, 80), observedAt: text(raw.observedAt, 80), validUntil: text(raw.validUntil, 80),
      status: Object.hasOwn(LABELS, status) ? status : 'review', canChangePrice: false,
      preference: { revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : null, excluded: preference.excluded === true, snoozedUntil: text(preference.snoozedUntil, 80) || null,
        sizeClass: ['normal','large'].includes(preference.sizeClass) ? preference.sizeClass : null }
    };
  }
  function normalizeSnapshot(raw) {
    if (!raw || raw.ok !== true || raw.mode !== 'suggestion_only' || typeof raw.configured !== 'boolean' || !Array.isArray(raw.items)) {
      throw new Error('価格管理データの形式を確認できません。0件として扱わず、前回の表示を残しています。');
    }
    const items = raw.items.map(normalizeItem);
    if (new Set(items.map(item => item.sku)).size !== items.length) throw new Error('同じSKUが重複しています。設定変更を停止しました。');
    return {
      ok: true, mode: 'suggestion_only', configured: raw.configured, generatedAt: text(raw.generatedAt, 80), items,
      sourceStatus: { code: text(raw.sourceStatus?.code, 100), message: text(raw.sourceStatus?.message), lastSuccessAt: text(raw.sourceStatus?.lastSuccessAt, 80) },
      coverage: { scope: text(raw.coverage?.scope, 300), total: number(raw.coverage?.total), loaded: number(raw.coverage?.loaded), eligible: number(raw.coverage?.eligible), excluded: number(raw.coverage?.excluded), unresolved: number(raw.coverage?.unresolved) }
    };
  }
  function itemState(item, now = Date.now()) {
    if (item.preference.excluded) return 'excluded';
    if (Date.parse(item.preference.snoozedUntil || '') > now) return 'snoozed';
    if (!proposalValid(item, now)) return 'review';
    return item.status;
  }
  function filterItems(items, query = '', filter = 'all', now = Date.now()) {
    const terms = text(query).trim().toLocaleLowerCase('ja').split(/\s+/).filter(Boolean);
    return items.filter(item => {
      const state = itemState(item, now);
      const matchesFilter = filter === 'all' ? state !== 'excluded'
        : filter === 'attention' ? ['lower', 'raise', 'review', 'blocked'].includes(state)
          : filter === 'review' ? ['review', 'blocked'].includes(state)
            : filter === 'hold' ? ['hold', 'keep'].includes(state) : state === filter;
      const haystack = `${item.sku} ${item.asin} ${item.title}`.toLocaleLowerCase('ja');
      return matchesFilter && terms.every(term => haystack.includes(term));
    });
  }
  function preferenceMatches(item, pending) {
    if (!item || item.sku !== pending.sku || !Number.isSafeInteger(item.preference.revision) || item.preference.revision <= pending.expectedRevision) return false;
    if (pending.action === 'exclude') return item.preference.excluded;
    if (pending.action === 'restore') return !item.preference.excluded && !item.preference.snoozedUntil;
    if (pending.action === 'set_size') return item.asin === pending.asin && item.preference.sizeClass === pending.sizeClass;
    if (pending.action === 'snooze') {
      const until = Date.parse(item.preference.snoozedUntil || '');
      const expected = Number(pending.startedAt) + pending.days * 86400000;
      return !item.preference.excluded && Number.isFinite(until) && Math.abs(until - expected) <= 15 * 60 * 1000;
    }
    return false;
  }
  function canEdit(snapshot, item, online, fresh, pending) {
    return online && fresh && snapshot?.configured === true && !isStale(snapshot) && !pending && Number.isSafeInteger(item.preference.revision);
  }
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }
  function button(label, callback, className = 'btn btn-outline') {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
  }
  function metric(label, value, emphasized = false) {
    const node = element('div', `amazon-pricing-metric${emphasized ? ' emphasized' : ''}`);
    node.append(element('dt', '', label), element('dd', '', value));
    return node;
  }

  async function render(container, options = {}) {
    disposeActive();
    const session = ++activeSession;
    const api = options.api || API;
    const storage = options.storage || Storage;
    const isCurrent = () => session === activeSession && container.contains(root);
    const online = () => navigator.onLine !== false;
    let snapshot = null, fresh = false, loading = false, saving = false, pending = null, storageReady = false, requestVersion = 0, errorMessage = '', query = '', filter = 'all', page = 0, expiryTimer = null;
    const root = element('section', 'amazon-pricing');
    const heading = element('header', 'amazon-pricing-heading');
    heading.append(button('ルートに戻る', () => { disposeActive(); ++activeSession; (options.onBack || (() => Router.navigate('home')))(); }, 'amazon-pricing-back'));
    heading.append(element('h1', '', 'Amazon価格管理'));
    heading.append(element('p', 'amazon-pricing-mode', '提案のみ · Amazonの価格は変更しません'));
    const intro = element('p', 'amazon-pricing-intro', 'いくらにするか、いつ見直すか。原価や相場を確認できない商品は、無理に金額を出しません。');
    const toolbar = element('div', 'amazon-pricing-toolbar');
    const refresh = button('最新データを確認', () => load(), 'btn btn-primary');
    const updated = element('p', 'amazon-pricing-updated');
    toolbar.append(refresh, updated);
    const notice = element('div', 'amazon-pricing-notice');
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const controls = element('div', 'amazon-pricing-controls');
    const searchLabel = element('label', '', '商品を探す');
    const search = element('input', 'form-input'); search.type = 'search'; search.placeholder = '商品名・SKU・ASIN'; search.autocomplete = 'off';
    search.addEventListener('input', () => { query = search.value; page = 0; drawList(); }); searchLabel.append(search);
    const filterLabel = element('label', '', '表示する商品');
    const select = element('select', 'form-select');
    [['all', '対象商品すべて'], ['attention', '対応が必要'], ['lower', '値下げを検討'], ['raise', '値上げを検討'], ['hold', '価格を維持'], ['review', '情報の確認が必要'], ['collecting', '情報を確認中'], ['snoozed', '様子見中'], ['excluded', '対象外']].forEach(([value, label]) => {
      const option = element('option', '', label); option.value = value; select.append(option);
    });
    select.addEventListener('change', () => { filter = select.value; page = 0; drawList(); }); filterLabel.append(select); controls.append(searchLabel, filterLabel);
    const count = element('p', 'amazon-pricing-count'); count.setAttribute('aria-live', 'polite');
    const scope = element('p', 'amazon-pricing-scope');
    const list = element('div', 'amazon-pricing-list');
    const pagination = element('div', 'amazon-pricing-pagination');
    const previous = button('前の50件', () => { page = Math.max(0, page - 1); drawList(); });
    const next = button('次の50件', () => { page++; drawList(); });
    pagination.append(previous, next);
    const foot = element('p', 'amazon-pricing-footnote', '金額は見込みです。参考下限価格は候補価格時点の手数料を固定した目安で、利益を保証する最低価格ではありません。未確認の費用は0円として扱いません。次の確認日は「その日までに売れる」という保証ではありません。プライスター等で自動改定中の商品も、この画面からは価格を変更しません。');
    root.append(heading, intro, toolbar, notice, controls, count, scope, list, pagination, foot);
    container.replaceChildren(root);

    function draw() {
      if (!isCurrent()) return;
      refresh.disabled = loading || saving || !online();
      refresh.textContent = loading ? '確認中…' : '最新データを確認';
      updated.textContent = snapshot ? `データ作成: ${time(snapshot.generatedAt)}（日本時間）` : '取得日時: 未確認';
      const messages = [];
      if (!online()) messages.push('オフラインです。前回取得価格は参考表示です。現在の提案ではないため目安価格・見込み利益・参考下限価格を非表示にし、設定変更を停止しています。');
      else if (snapshot && (!fresh || isStale(snapshot))) messages.push('前回取得した情報です。現在の提案ではないため目安価格・見込み利益・参考下限価格を非表示にし、設定変更を停止しています。最新データを再取得してください。');
      if (snapshot?.configured === false) messages.push('Amazon価格管理の接続準備中です。確認できた商品だけを表示しています。未確認の金額は「未確認」と表示します。');
      if (snapshot?.sourceStatus.message) messages.push(snapshot.sourceStatus.message);
      if (errorMessage) messages.push(errorMessage);
      if (pending) messages.push('設定の保存結果が未確認です。二重保存を防ぐため再送しません。「最新データを確認」で保存結果を照合します。');
      if (!storageReady && !loading) messages.push('端末の保存記録を確認できるまで、設定変更を停止しています。');
      if (saving) messages.push('設定を保存して、結果を確認しています…');
      if (!snapshot && loading) messages.push('Amazon価格管理のデータを読み込んでいます。');
      notice.replaceChildren(...messages.map(message => element('p', '', message)));
      notice.hidden = messages.length === 0;
      notice.classList.toggle('has-warning', Boolean(errorMessage || pending || snapshot?.configured === false || !online() || (snapshot && !fresh)));
      drawList();
      scheduleExpiry();
    }
    function scheduleExpiry() {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      if (!isCurrent() || !snapshot) return;
      const now = Date.now();
      const times = [Date.parse(snapshot.generatedAt || '') + MAX_AGE_MS,
        ...snapshot.items.flatMap(item => [Date.parse(item.quantityObservedAt || '') + MAX_AGE_MS, Date.parse(item.observedAt || '') + MAX_AGE_MS]),
        ...snapshot.items.filter(item => PROPOSAL_STATES.has(item.status)).map(item => Date.parse(item.validUntil || ''))].filter(value => Number.isFinite(value) && value > now);
      if (times.length) expiryTimer = setTimeout(() => { if (isCurrent()) draw(); }, Math.min(Math.min(...times) - now + 1, 2147483647));
    }
    function drawList() {
      if (!isCurrent()) return;
      list.replaceChildren(); controls.hidden = !snapshot; count.hidden = !snapshot; scope.hidden = !snapshot; pagination.hidden = true;
      if (!snapshot) {
        if (!loading) list.append(element('div', 'amazon-pricing-empty', online() ? '商品一覧をまだ確認できていません。「最新データを確認」からもう一度読み込めます。' : 'この端末に保存済みの価格管理データがありません。接続が戻ってから確認してください。'));
        return;
      }
      const items = filterItems(snapshot.items, query, filter);
      const total = snapshot.coverage.total;
      page = Math.min(page, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
      const offset = page * PAGE_SIZE;
      const visibleItems = items.slice(offset, offset + PAGE_SIZE);
      count.textContent = `${items.length ? `${offset + 1}〜${offset + visibleItems.length}件` : '0件'}を表示 / 条件一致 ${items.length}件 / 取得できた商品 ${snapshot.items.length}件${total !== null ? `（対象範囲の全${total}件）` : '（対象範囲の全件数は未確認）'}`;
      scope.textContent = `対象範囲: ${snapshot.coverage.scope || SCOPE_LABEL}`;
      if (!items.length) {
        const label = snapshot.items.length ? 'この条件に合う商品はありません。検索語や表示条件を変更してください。'
          : snapshot.configured && fresh && snapshot.coverage.total === 0 ? '確認した範囲に対象商品はありません。'
            : '商品をまだ表示できません。未設定・未取得の状態は、在庫0件という意味ではありません。';
        list.append(element('div', 'amazon-pricing-empty', label));
      }
      visibleItems.forEach(item => list.append(itemCard(item)));
      pagination.hidden = items.length <= PAGE_SIZE;
      previous.disabled = page === 0; next.disabled = offset + PAGE_SIZE >= items.length;
    }
    function itemCard(item) {
      const state = itemState(item);
      const previousData = !online() || !fresh || isStale(snapshot);
      const valid = proposalValid(item);
      const showProposal = !previousData && snapshot.configured && valid;
      const article = element('article', 'amazon-pricing-item');
      const top = element('div', 'amazon-pricing-item-top');
      top.append(element('span', `amazon-pricing-status state-${state}`, LABELS[state] || LABELS.review));
      if (Number.isSafeInteger(item.quantity) && item.quantity >= 0) top.append(element('span', 'amazon-pricing-quantity',
        !previousData && quantityCurrent(item) ? `販売可能 ${item.quantity}点（${time(item.quantityObservedAt)}確認）` : `前回確認 ${item.quantity}点（参考・${time(item.quantityObservedAt)}）`));
      else top.append(element('span','amazon-pricing-quantity','販売可能数は未確認'));
      article.append(top, element('h2', '', item.title));
      article.append(element('p', 'amazon-pricing-identifiers', `SKU: ${item.sku} / ASIN: ${item.asin || '未確認'}`));
      article.append(element('p', 'amazon-pricing-conditions', `状態: ${conditionLabel(item.condition)} / 配送: ${item.fulfillment || '未確認'}`));
      const prices = element('dl', 'amazon-pricing-prices');
      prices.append(metric(previousData || !factFresh(item.observedAt) ? '前回取得価格（参考）' : '現在の価格', money(item.currentPrice)), metric('目安の価格', money(showProposal ? item.suggestedPrice : null), true)); article.append(prices);
      const costs = element('dl', 'amazon-pricing-costs');
      costs.append(metric('見込み利益', money(showProposal ? item.estimatedProfit : null)), metric('参考下限価格', money(showProposal ? item.minPrice : null))); article.append(costs);
      const reasons = element('div', 'amazon-pricing-reasons'); reasons.append(element('h3', '', previousData || !valid ? '前回の判断理由（現在の提案ではありません）' : 'この判断の理由'));
      (item.reasons.length ? item.reasons : ['判断に必要な情報をまだ確認できていません。']).forEach(reason => reasons.append(element('p', '', reason)));
      const warnings = [...item.warnings];
      if (!valid) warnings.unshift('提案の有効期限が切れているか、期限を確認できません。最新データを再取得してください。金額は未確認に戻しています。');
      if (previousData) warnings.unshift('前回取得した情報の参考表示です。最新の提案として使わず、再取得してください。');
      if (item.estimatedProfit === null && !warnings.some(message => /利益|原価|費用/.test(message))) warnings.push('原価・手数料等がそろっていないため、利益は未確認です。');
      if (warnings.length) { const warning = element('div', 'amazon-pricing-item-warning'); warnings.forEach(message => warning.append(element('p', '', message))); reasons.append(warning); }
      article.append(reasons);
      const reviewAt = state === 'snoozed' ? item.preference.snoozedUntil : item.nextReviewAt;
      article.append(element('p', 'amazon-pricing-review', `次の確認: ${state === 'excluded' ? '対象外（通知しません）' : time(reviewAt)}`));
      article.append(element('p', 'amazon-pricing-observed', `販売可能な期間: ${item.availableDays === null ? '未確認' : `${item.availableDays}日`} / 価格取得: ${time(item.observedAt)}`));
      if (PROPOSAL_STATES.has(item.status)) article.append(element('p', 'amazon-pricing-observed', `提案の有効期限: ${time(item.validUntil)}${valid ? '' : '（要再確認）'}`));
      const actions = element('div', 'amazon-pricing-actions');
      const disabled = saving || loading || !storageReady || !canEdit(snapshot, item, online(), fresh, pending);
      const sizeLabel = item.preference.sizeClass === 'large' ? '大型・1点1,000円' : item.preference.sizeClass === 'normal' ? '通常・追加費用なし' : '区分は未確認';
      article.append(element('p','amazon-pricing-action-note', `納品送料など: ${sizeLabel}。販売手数料・FBA配送手数料は別計算です。`));
      const sizeActions = element('div','amazon-pricing-actions');
      for (const [value,label] of [['normal','通常商品に設定'],['large','大型商品に設定']]) {
        const node = button(label, () => save(item,'set_size',null,{asin:item.asin,sizeClass:value}));
        node.disabled = disabled || item.preference.sizeClass === value; sizeActions.append(node);
      }
      article.append(sizeActions);
      const addAction = (label, action, days) => { const node = button(label, () => save(item, action, days)); node.disabled = disabled; actions.append(node); };
      if (state === 'excluded') addAction('対象に戻す', 'restore');
      else { addAction('3日様子を見る', 'snooze', 3); addAction('7日様子を見る', 'snooze', 7); if (state === 'snoozed') addAction('様子見を解除', 'restore'); addAction('対象外にする', 'exclude'); }
      article.append(actions);
      if (disabled && !saving) article.append(element('p', 'amazon-pricing-action-note', pending ? '保存結果の確認待ちです' : '最新データと接続を確認できると、見直し設定を変更できます'));
      return article;
    }
    async function load() {
      if (loading || saving || !isCurrent() || !online()) return;
      const version = ++requestVersion; loading = true; errorMessage = ''; draw();
      try {
        const operationRecord = await storage.getViewCache(PENDING_KEY);
        if (operationRecord?.data?.operation_id) pending = operationRecord.data;
        storageReady = true;
        const result = normalizeSnapshot(await api.getAmazonPricing());
        if (!isCurrent() || version !== requestVersion) return;
        snapshot = result; fresh = !isStale(result);
        if (pending && preferenceMatches(result.items.find(item => item.sku === pending.sku), pending)) {
          await storage.settlePendingAction(pending.operation_id, { remove: true });
          await storage.clearViewCache(PENDING_KEY); pending = null;
        }
        await storage.saveViewCache(CACHE_KEY, result);
      } catch (error) {
        if (!isCurrent() || version !== requestVersion) return;
        fresh = false; errorMessage = '最新データを確認できませんでした。取得済みの情報を残しています。設定変更は停止中です。';
      } finally {
        if (isCurrent() && version === requestVersion) { loading = false; draw(); }
      }
    }
    async function save(item, action, days, fields = {}) {
      if (saving || loading || !storageReady || !isCurrent() || !canEdit(snapshot, item, online(), fresh, pending)) return;
      saving = true; errorMessage = ''; ++requestVersion; draw();
      const operation = { sku: item.sku, action, ...(days ? { days } : {}), ...fields, expectedRevision: item.preference.revision, operation_id: api.createOperationId('updateAmazonPricingPreference'), startedAt: Date.now() };
      let dispatched = false, updateCompleted = false;
      try {
        await storage.saveViewCache(PENDING_KEY, operation);
        const recorded = await storage.getViewCache(PENDING_KEY);
        if (recorded?.data?.operation_id !== operation.operation_id) throw new Error('LOCAL_PENDING_UNVERIFIED');
        pending = operation; dispatched = true;
        const { startedAt, ...body } = operation;
        const response = await api.updateAmazonPricingPreference(body);
        updateCompleted = true;
        if (!response || response.ok !== true || response.verified !== true || !response.item) throw new Error('UNKNOWN_SAVE_RESULT');
        const updatedItem = normalizeItem(response.item);
        if (!preferenceMatches(updatedItem, operation)) throw new Error('SAVE_READBACK_MISMATCH');
        // API応答の自己申告だけでなく、一覧の読み戻しでも同じ設定を確認する。
        const result = normalizeSnapshot(await api.getAmazonPricing());
        if (!preferenceMatches(result.items.find(value => value.sku === item.sku), operation)) throw new Error('SAVE_READBACK_MISMATCH');
        await storage.saveViewCache(CACHE_KEY, result);
        await storage.settlePendingAction(operation.operation_id, { remove: true });
        await storage.clearViewCache(PENDING_KEY);
        if (!isCurrent()) return;
        pending = null; snapshot = result; fresh = !isStale(result);
        errorMessage = '';
      } catch (error) {
        if (dispatched && !updateCompleted && CONFIRMED_REJECTIONS.has(error?.code)) {
          // この5codeだけはAPI側で「書き込まれていない」と確定した拒否。
          // TIMEOUTや未知API_ERRORは保存済みの可能性があるので、この経路へ入れない。
          try {
            await storage.clearViewCache(PENDING_KEY);
            pending = null; fresh = false;
            errorMessage = '設定は保存されませんでした。最新データと接続を確認してから、もう一度操作してください。';
          } catch (clearError) {
            pending = operation; fresh = false;
            errorMessage = '設定は保存されていませんが、端末の受付記録を解除できませんでした。再送せず、保存記録の確認を停止しています。';
          }
        }
        else if (!isCurrent()) return;
        else if (!dispatched) { pending = null; errorMessage = '端末に確認用の記録を保存できなかったため、送信していません。'; }
        else { pending = operation; fresh = false; errorMessage = '保存結果を確認できませんでした。設定が保存されている可能性があるため、再送していません。'; }
      } finally {
        if (isCurrent()) { saving = false; draw(); }
      }
    }
    draw();
    try {
      const [cached, operation] = await Promise.all([storage.getViewCache(CACHE_KEY), storage.getViewCache(PENDING_KEY)]);
      if (!isCurrent()) return;
      if (cached?.data) snapshot = normalizeSnapshot(cached.data);
      if (operation?.data?.operation_id) pending = operation.data;
      storageReady = true;
    } catch (error) { errorMessage = 'この端末の保存済みデータを確認できませんでした。'; }
    if (!isCurrent()) return;
    draw();
    const networkChanged = () => { if (isCurrent()) draw(); else dispose(); };
    const visibilityChanged = () => { if (isCurrent()) draw(); else dispose(); };
    const hashChanged = () => { if (!isCurrent()) dispose(); };
    function dispose() { if (expiryTimer !== null) clearTimeout(expiryTimer); expiryTimer = null; window.removeEventListener('online', networkChanged); window.removeEventListener('offline', networkChanged); window.removeEventListener('hashchange', hashChanged); document.removeEventListener('visibilitychange', visibilityChanged); }
    disposeActive = dispose;
    window.addEventListener('online', networkChanged); window.addEventListener('offline', networkChanged);
    window.addEventListener('hashchange', hashChanged); document.addEventListener('visibilitychange', visibilityChanged);
    await load();
  }
  return { render, normalizeSnapshot, normalizeItem, money, time, isStale, proposalValid, factFresh, quantityCurrent, conditionLabel, filterItems, itemState, preferenceMatches, canEdit };
})();
