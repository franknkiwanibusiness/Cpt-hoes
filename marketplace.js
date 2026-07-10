/* ── from index.html lines 2235-6318 ── */
            // ── MARKETPLACE OVERLAY LOGIC ──
            // Uses window.__db / window.__auth set by the main Firebase init above.
            import {
              collection, query, where, getDocs, orderBy, limit
            } from "https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js";
            
            // ── DOM refs ──
            const overlay       = document.getElementById('marketplaceOverlay');
            const mpBody        = document.getElementById('mpBody');
            const mpGrid        = document.getElementById('mpGrid');
            const mpLoading     = document.getElementById('mpLoading');
            const mpEmpty       = document.getElementById('mpEmpty');
            const mpError       = document.getElementById('mpError');
            const mpResultCount = document.getElementById('mpResultCount');
            const mpSearchInput = document.getElementById('mpSearchInput');
            const mpSearchClear = document.getElementById('mpSearchClear');
            const mpSuggest     = document.getElementById('mpSuggest');
            const mpActiveTags  = document.getElementById('mpActiveTags');
            const mpAiSearchBtn = document.getElementById('mpAiSearchBtn');
            const mpGlobalLoader = document.getElementById('mpGlobalLoader');
            const mpModal       = document.getElementById('mpModal');
            const mpModalBody   = document.getElementById('mpModalBody');
            const mpFilterTemplate = document.getElementById('mpFilterTemplate');
            const mpFilterPrice    = document.getElementById('mpFilterPrice');
            const mpPriceLabel     = document.getElementById('mpPriceLabel');
            const mpPricePopover   = document.getElementById('mpPricePopover');
            const mpPopClose       = document.getElementById('mpPopClose');
            const mpSliderMin      = document.getElementById('mpSliderMin');
            const mpSliderMax      = document.getElementById('mpSliderMax');
            const mpSliderRange    = document.getElementById('mpSliderRange');
            const mpExactMin       = document.getElementById('mpExactMin');
            const mpExactMax       = document.getElementById('mpExactMax');
            const mpPriceReset     = document.getElementById('mpPriceReset');
            const mpPriceApply     = document.getElementById('mpPriceApply');
            const typeChips        = document.querySelectorAll('.mp-chip[data-mptype]');
            
            // ── State ──
            let mpListings       = [];
            let mpTypeFilter     = 'all';
            let mpTemplateFilter = 'all';
            let mpPriceMin       = 0;
            let mpPriceMax       = null;
            let mpSearchQuery    = '';
            const PRICE_CAP      = (window.__limits?.marketplace?.priceCap) || 10000;
            let mpLoaded         = false;
            let mpTopSellersLoaded = false;

            // ── Lazy-load pagination state ──
            // (Declared here, before anything in this module runs mpLoadListings(),
            // since these bindings are referenced inside that function and must
            // exist before the eager load call further down triggers it.)
            const MP_PAGE_SIZE = 12;
            let _mpCursor    = null;  // opaque per-type offsets returned by /api/listings listing.feed
            let _mpSeed      = null;  // shuffle seed for this browsing session — echoed back each page
            let _mpFetching  = false; // guard against concurrent fetches
            let _mpExhausted = false; // no more pages
            let _mpObserver  = null;
            
            // ── Marketplace is now an inline page section (no longer a
            // full-screen modal), so "open" just means "load data + scroll
            // into view" and "close" just means "scroll back to top".
            window.__openMarketplace = function(param, opts) {
              opts = opts || {};
              overlay.scrollIntoView({ behavior: opts.skipHistory ? 'auto' : 'smooth', block: 'start' });
              // First load: show one unified shimmer overlay covering the
              // whole marketplace body, and hide it only once every
              // section's first load has settled (success or fail) —
              // avoids several independent skeletons popping in/out at
              // different times.
              if (!mpLoaded && !mpTopSellersLoaded) {
                mpGlobalLoader?.classList.add('active');
                Promise.allSettled([mpLoadListings(), mpLoadTopSellers()])
                  .finally(() => mpGlobalLoader?.classList.remove('active'));
              } else {
                if (!mpLoaded) mpLoadListings();
                if (!mpTopSellersLoaded) mpLoadTopSellers();
              }
            };
            window.__closeMarketplace = function(opts) {
              opts = opts || {};
              window.scrollTo({ top: 0, behavior: 'smooth' });
              if (!opts.skipHistory) window.__srfSetSectionPath?.('/');
            };

            // Load the marketplace data immediately since the section is
            // always present on the page now — but only once Firebase Auth
            // has resolved (mpLoadListings needs a signed-in user to call
            // /api/listings). Without this gate, this fires before auth
            // settles, hits the "not signed in" branch, and lands the
            // section straight in the error state with nothing actually
            // broken — indistinguishable from a real fetch failure.
            mpGlobalLoader?.classList.add('active');
            (window.__authReady || Promise.resolve()).then(() => {
              Promise.allSettled([mpLoadListings(), mpLoadTopSellers()])
                .finally(() => mpGlobalLoader?.classList.remove('active'));
            });

            // ── AI Search — calls /api/aistudio (action: 'recommendations').
            // No text input: this is a zero-input "Recommended for you"
            // panel that runs the moment it's opened (via the sparkle
            // button click). Typed keyword search still lives in the
            // regular search bar, untouched. Folded into aistudio.js
            // (rather than its own /api/aisearch.js file) to stay under
            // the hobby-plan serverless function count. ──
            const mpAiSearchPanel    = document.getElementById('mpAiSearchPanel');
            const mpAiSearchClose    = document.getElementById('mpAiSearchClose');
            const mpAiSearchReply    = document.getElementById('mpAiSearchReply');
            const mpAiSearchResults  = document.getElementById('mpAiSearchResults');

            let _mpAiLoadedOnce = false; // avoid re-fetching every time the panel is reopened in the same session

            window.__openAiSearch = function() {
              mpAiSearchPanel.style.display = 'block';
              if (!_mpAiLoadedOnce) mpRunAiSearch();
            };
            mpAiSearchBtn?.addEventListener('click', () => window.__openAiSearch());

            mpAiSearchClose?.addEventListener('click', () => {
              mpAiSearchPanel.style.display = 'none';
            });

            function mpAppendAiResults(listings) {
              (listings || []).forEach(lite => {
                const full = mpListings.find(l => l.id === lite.id);
                const listing = full || {
                  id: lite.id, title: lite.title, type: lite.type,
                  financials: { price: lite.price }, status: 'active',
                };
                mpAiSearchResults.appendChild(mpRenderCard(listing));
              });
            }

            async function mpRunAiSearch() {
              mpAiSearchReply.className = 'is-loading';
              mpAiSearchReply.classList.add('active');
              mpAiSearchReply.textContent = 'Finding listings for you…';
              mpAiSearchResults.innerHTML = '';

              try {
                const user = window.__auth?.currentUser;
                const headers = { 'Content-Type': 'application/json' };
                if (user) {
                  const token = await user.getIdToken();
                  headers.Authorization = `Bearer ${token}`;
                }

                const resp = await fetch('/api/aistudio', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ action: 'recommendations' }),
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Search failed');

                mpAiSearchReply.className = 'active';
                mpAiSearchReply.textContent = data.reply || '';

                mpAiSearchResults.innerHTML = '';
                mpAppendAiResults(data.listings);
                _mpAiLoadedOnce = true;
              } catch (err) {
                console.error('[AI Search] failed', err);
                mpAiSearchReply.className = 'active';
                mpAiSearchReply.textContent = 'Something went wrong with AI Search — please try again.';
              }
            }

            // Note: if the user signs in while the panel is already open,
            // personalization won't retroactively kick in until they close
            // and reopen the panel (or reload) — window.__auth is a plain
            // Firebase Auth instance here, not an event target we can hook.
            // Re-running on onAuthStateChanged (defined earlier in this
            // file) would need _mpAiLoadedOnce reset from there instead.

            // ── Error state retry ──
            document.getElementById('mpRetryBtn')?.addEventListener('click', () => {
              mpLoaded = false;
              mpError.style.display = 'none';
              mpListings = []; _mpCursor = null; _mpSeed = null; _mpExhausted = false;
              mpShowSkeletonCards();
              mpLoadListings(true);
            });
            
            // ── Search ──
            mpSearchInput.addEventListener('input', () => {
              mpSearchQuery = mpSearchInput.value.trim().toLowerCase();
              mpSearchClear.style.display = mpSearchQuery ? 'flex' : 'none';
              mpRenderSuggestions();
              mpApplyAndRender();
            });
            mpSearchInput.addEventListener('focus', mpRenderSuggestions);
            mpSearchClear.addEventListener('click', () => {
              mpSearchInput.value = '';
              mpSearchQuery = '';
              mpSearchClear.style.display = 'none';
              mpHideSuggest();
              mpApplyAndRender();
            });
            document.addEventListener('click', e => {
              if (!mpSuggest.contains(e.target) && e.target !== mpSearchInput) mpHideSuggest();
            });
            mpSearchInput.addEventListener('keydown', e => { if (e.key === 'Escape') mpHideSuggest(); });
            
            function mpHideSuggest() {
              mpSuggest.classList.remove('active');
              mpSuggest.innerHTML = '';
            }
            function mpHL(text, q) {
              if (!q) return text;
              const i = text.toLowerCase().indexOf(q);
              if (i === -1) return text;
              return text.slice(0,i) + '<mark>' + text.slice(i, i+q.length) + '</mark>' + text.slice(i+q.length);
            }
            function mpPositionSuggest() {
              const r = mpSearchInput.getBoundingClientRect();
              mpSuggest.style.top    = (r.bottom + 6) + 'px';
              mpSuggest.style.left   = r.left + 'px';
              mpSuggest.style.width  = r.width + 'px';
            }
            function mpRenderSuggestions() {
              if (!mpSearchQuery) { mpHideSuggest(); return; }
              const matches = mpListings.map(l => {
                const title = l.title || 'Untitled', type = l.type || 'website', desc = l.description || '';
                let score = -1;
                if (title.toLowerCase().startsWith(mpSearchQuery)) score = 100;
                else if (title.toLowerCase().includes(mpSearchQuery)) score = 80;
                else if (type.toLowerCase().includes(mpSearchQuery)) score = 60;
                else if (desc.toLowerCase().includes(mpSearchQuery)) score = 40;
                return { l, score, title, type };
              }).filter(m => m.score >= 0).sort((a,b) => b.score - a.score).slice(0,6);
            
              if (!matches.length) {
                mpSuggest.innerHTML = `<div class="suggest-empty">No matches for "${mpSearchQuery}"</div>`;
                mpPositionSuggest();
                mpSuggest.classList.add('active'); return;
              }
              mpSuggest.innerHTML = matches.map(m => {
                const price = m.l.financials?.price;
                const priceStr = typeof price === 'number' ? `$${price.toLocaleString()}` : '—';
                const tc = m.type==='website'?'#60a5fa':m.type==='app'?'#a78bfa':m.type==='game'?'#f59e0b':'#34d399';
                return `<button class="suggest-item" data-sid="${m.l.id}">
                  <span class="suggest-dot" style="background:${tc}"></span>
                  <span class="suggest-text">
                    <span class="suggest-title">${mpHL(m.title, mpSearchQuery)}</span>
                    <span class="suggest-sub">${m.type}</span>
                  </span>
                  <span class="suggest-price">${priceStr}</span>
                </button>`;
              }).join('') + `<div class="suggest-footer">Click a result to view it</div>`;
              mpPositionSuggest();
              mpSuggest.classList.add('active');
              mpSuggest.querySelectorAll('.suggest-item').forEach(btn => {
                btn.addEventListener('click', () => {
                  const listing = mpListings.find(l => l.id === btn.dataset.sid);
                  if (listing) { mpHideSuggest(); mpOpenModal(listing); }
                });
              });
            }
            window.addEventListener('resize', () => { if (mpSuggest.classList.contains('active')) mpPositionSuggest(); });
            
            // ── Type filter chips ──
            typeChips.forEach(btn => {
              btn.addEventListener('click', () => {
                typeChips.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                mpTypeFilter = btn.dataset.mptype;
                mpUpdateActiveTags();
                mpListings = []; _mpCursor = null; _mpSeed = null; _mpExhausted = false;
                mpShowSkeletonCards();
                mpLoadListings(true);
              });
            });
            
            // ── Template filter ──
            mpFilterTemplate.addEventListener('click', () => {
              const cur = mpFilterTemplate.dataset.state || 'all';
              const next = cur==='all'?'template':cur==='template'?'not-template':'all';
              mpFilterTemplate.dataset.state = next;
              mpTemplateFilter = next;
              mpFilterTemplate.classList.remove('active','active-alt');
              if (next==='template') {
                mpFilterTemplate.classList.add('active');
                mpFilterTemplate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg> Templates only`;
              } else if (next==='not-template') {
                mpFilterTemplate.classList.add('active-alt');
                mpFilterTemplate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="12" x2="16" y2="12"/></svg> Full products`;
              } else {
                mpFilterTemplate.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Any type`;
              }
              mpUpdateActiveTags();
              mpApplyAndRender(true);
            });
            
            // ── Price popover ──
            function mpOpenPrice() {
              const r = mpFilterPrice.getBoundingClientRect();
              const popW = Math.min(300, window.innerWidth - 32);
              let left = r.left + r.width/2 - popW/2;
              if (left < 16) left = 16;
              if (left + popW > window.innerWidth - 16) left = window.innerWidth - 16 - popW;
              mpPricePopover.style.top  = (r.bottom + 8) + 'px';
              mpPricePopover.style.left = left + 'px';
              mpPricePopover.style.width = popW + 'px';
              mpPricePopover.classList.add('active');
              mpFilterPrice.classList.add('active');
            }
            function mpClosePrice() { mpPricePopover.classList.remove('active'); }
            mpFilterPrice.addEventListener('click', e => { e.stopPropagation(); mpPricePopover.classList.contains('active')?mpClosePrice():mpOpenPrice(); });
            mpPopClose.addEventListener('click', e => { e.stopPropagation(); mpClosePrice(); });
            mpPricePopover.addEventListener('click', e => e.stopPropagation());
            document.addEventListener('click', e => {
              if (!mpPricePopover.contains(e.target) && e.target !== mpFilterPrice && !mpFilterPrice.contains(e.target)) mpClosePrice();
            });
            
            function mpUpdateSliderUI() {
              const lo = Math.min(+mpSliderMin.value, +mpSliderMax.value);
              const hi = Math.max(+mpSliderMin.value, +mpSliderMax.value);
              mpSliderRange.style.left  = (lo/PRICE_CAP*100)+'%';
              mpSliderRange.style.right = (100 - hi/PRICE_CAP*100)+'%';
            }
            mpSliderMin.addEventListener('input', () => {
              if (+mpSliderMin.value > +mpSliderMax.value) mpSliderMin.value = mpSliderMax.value;
              mpExactMin.value = mpSliderMin.value;
              mpUpdateSliderUI();
            });
            mpSliderMax.addEventListener('input', () => {
              if (+mpSliderMax.value < +mpSliderMin.value) mpSliderMax.value = mpSliderMin.value;
              mpExactMax.value = +mpSliderMax.value >= PRICE_CAP ? '' : mpSliderMax.value;
              mpUpdateSliderUI();
            });
            mpExactMin.addEventListener('input', () => { const v=parseFloat(mpExactMin.value); mpSliderMin.value=isNaN(v)?0:Math.min(v,PRICE_CAP); mpUpdateSliderUI(); });
            mpExactMax.addEventListener('input', () => { const v=parseFloat(mpExactMax.value); mpSliderMax.value=isNaN(v)?PRICE_CAP:Math.min(v,PRICE_CAP); mpUpdateSliderUI(); });
            
            mpPriceReset.addEventListener('click', () => {
              mpSliderMin.value=0; mpSliderMax.value=PRICE_CAP;
              mpExactMin.value=''; mpExactMax.value='';
              mpUpdateSliderUI(); mpPriceMin=0; mpPriceMax=null;
              mpUpdatePriceLabel(); mpUpdateActiveTags(); mpListings=[]; _mpCursor=null; _mpSeed=null; _mpExhausted=false; mpShowSkeletonCards(); mpLoadListings(true); mpClosePrice();
            });
            mpPriceApply.addEventListener('click', () => {
              const eMin=parseFloat(mpExactMin.value), eMax=parseFloat(mpExactMax.value);
              mpPriceMin = !isNaN(eMin)?eMin:+mpSliderMin.value;
              mpPriceMax = !isNaN(eMax)?eMax:(+mpSliderMax.value>=PRICE_CAP?null:+mpSliderMax.value);
              if (mpPriceMax!==null && mpPriceMin>mpPriceMax) { const t=mpPriceMin; mpPriceMin=mpPriceMax; mpPriceMax=t; }
              mpUpdatePriceLabel(); mpUpdateActiveTags(); mpApplyAndRender(); mpClosePrice();
            });
            
            function mpFmt(n) { return Number.isInteger(n)?n.toLocaleString():n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
            function mpUpdatePriceLabel() {
              const hMin=mpPriceMin>0, hMax=mpPriceMax!==null;
              let lbl='Any price';
              if (hMin&&hMax) lbl=`$${mpFmt(mpPriceMin)} – $${mpFmt(mpPriceMax)}`;
              else if (hMin) lbl=`$${mpFmt(mpPriceMin)}+`;
              else if (hMax) lbl=`Up to $${mpFmt(mpPriceMax)}`;
              mpPriceLabel.textContent=lbl;
              mpFilterPrice.classList.toggle('active', hMin||hMax);
            }
            mpUpdateSliderUI();
            
            // ── Active filter tags ──
            function mpUpdateActiveTags() {
              const tags = [];
              if (mpTypeFilter!=='all') {
                tags.push({ label:`Type: ${mpTypeFilter}`, clear:()=>{ mpTypeFilter='all'; typeChips.forEach(b=>b.classList.remove('active')); document.querySelector('.mp-chip[data-mptype="all"]')?.classList.add('active'); mpListings=[]; _mpCursor=null; _mpSeed=null; _mpExhausted=false; mpUpdateActiveTags(); mpLoadListings(true); } });
              }
              if (mpTemplateFilter!=='all') {
                const lbl = mpTemplateFilter==='template'?'Templates only':'Full products';
                tags.push({ label:lbl, clear:()=>{ mpTemplateFilter='all'; mpFilterTemplate.dataset.state='all'; mpFilterTemplate.classList.remove('active','active-alt'); mpFilterTemplate.innerHTML=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Any type`; mpUpdateActiveTags(); mpApplyAndRender(); } });
              }
              if (mpPriceMin>0||mpPriceMax!==null) {
                const hMin=mpPriceMin>0, hMax=mpPriceMax!==null;
                let lbl; if(hMin&&hMax)lbl=`Price: $${mpFmt(mpPriceMin)} – $${mpFmt(mpPriceMax)}`; else if(hMin)lbl=`Price: $${mpFmt(mpPriceMin)}+`; else lbl=`Price: up to $${mpFmt(mpPriceMax)}`;
                tags.push({ label:lbl, clear:()=>{ mpPriceMin=0;mpPriceMax=null;mpSliderMin.value=0;mpSliderMax.value=PRICE_CAP;mpExactMin.value='';mpExactMax.value='';mpUpdateSliderUI();mpUpdatePriceLabel();mpUpdateActiveTags();mpApplyAndRender(); } });
              }
              mpActiveTags.innerHTML = tags.map(t=>`<span class="active-filter-tag">${t.label}<button class="tag-remove-btn" aria-label="Remove filter"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></span>`).join('');
              mpActiveTags.querySelectorAll('.tag-remove-btn').forEach((btn,i)=>btn.addEventListener('click',()=>tags[i].clear()));
              mpActiveTags.style.display = tags.length ? 'flex' : 'none';
            }
            
            // ── Filter + render ──
            function mpApplyAndRender(reset = true) {
              let f = [...mpListings];
              if (mpSearchQuery) f = f.filter(l=>(l.title||'').toLowerCase().includes(mpSearchQuery)||(l.description||'').toLowerCase().includes(mpSearchQuery)||(l.type||'').toLowerCase().includes(mpSearchQuery));
              if (mpTypeFilter!=='all') f = f.filter(l=>(l.type||'website')===mpTypeFilter);
              if (mpTemplateFilter==='template') f = f.filter(l=>l.isTemplate===true);
              else if (mpTemplateFilter==='not-template') f = f.filter(l=>!l.isTemplate);
              if (mpPriceMin>0||mpPriceMax!==null) f = f.filter(l=>{ const p=l.financials?.price; if(typeof p!=='number')return false; if(mpPriceMin>0&&p<mpPriceMin)return false; if(mpPriceMax!==null&&p>mpPriceMax)return false; return true; });
              mpResultCount.textContent = `${f.length} listing${f.length!==1?'s':''}`;
              // For filters/search always full re-render; for paginated appends partial
              if (reset) {
                mpRenderCards(f);
              } else {
                // Append only the newly-fetched batch (last MP_PAGE_SIZE items)
                const batch = f.slice(-MP_PAGE_SIZE);
                mpRenderCards(batch, false);
              }
            }
            
            /* ═══════════════════════════════════════════════════════
               MARKETPLACE FEED ORDERING
               Ordering/shuffling is entirely server-owned — see
               /api/listings' listing.feed action (seeded per-session
               shuffle, interleaved 1-1-1 across website/app/game). The
               client renders mpListings in the order received and never
               re-sorts or re-shuffles it. Boost is a badge only (see
               _isBoosted below) and does not affect ordering.
            ═══════════════════════════════════════════════════════ */
            const FLAME_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 1.5c.4 2.6-.6 4.3-2 5.8-1.7 1.8-3.5 3.6-3.5 6.7 0 3.6 2.9 6.5 6.5 6.5 3.4 0 6.2-2.6 6.5-5.9.3-3.4-1.6-5.9-3.3-7.8-.4-.5-1.1-.2-1 .4.4 2-.2 3.3-1.1 4.2-.2.2-.5.1-.6-.1-.7-1.6-.6-3.5.1-5.2.7-1.6.9-3.2-.6-4.6-.3-.3-.8-.2-.9.2-.2.7-.5 1.4-1.1 1.9-1.1 1-2.4 2.1-2.4 4 0 1.1.5 2 1.2 2.7.2.2 0 .6-.3.5-1.6-.5-2.7-2-2.5-3.7C7.7 4.9 9.6 2.9 12.5 1.5z"/></svg>';
            const HEART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#777" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>';
            const STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.4l-6.1 3.3 1.5-6.7-5.1-4.6 6.8-.7L12 2.5z"/></svg>';

            // .sr-premium-badge CSS now lives in styles.css (right after
            // .sr-boost) — matches the real flat/no-glow badge shell used
            // across the site instead of a one-off inline style.


            // ── Save / unsave a listing. +1 saves on the listing doc (used by
            // AI Search's "top listings" ranking), and tracks per-user saves
            // under users/{uid}/savedListings/{listingId} so we know whether
            // to increment or decrement, and can render "saved" state on load.
            const _mpSavedCache = new Set();
            let _mpSavedCacheLoaded = false;
            async function _mpLoadSavedCache() {
              if (_mpSavedCacheLoaded) return _mpSavedCache;
              _mpSavedCacheLoaded = true;
              const user = window.__auth?.currentUser;
              if (!user) return _mpSavedCache;
              try {
                const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                const db = await window.__dbReady;
                const snap = await getDocs(collection(db, 'users', user.uid, 'savedListings'));
                snap.forEach(d => _mpSavedCache.add(d.id));
              } catch (err) { console.error('[mpSaved] load failed', err); }
              return _mpSavedCache;
            }

            async function mpToggleSave(listing, btn) {
              const user = window.__auth?.currentUser;
              if (!user) { window.__openAuthModal?.('signin'); return; }
              const listingId = listing.id;
              if (!listingId) return;

              await _mpLoadSavedCache();
              const alreadySaved = _mpSavedCache.has(listingId);

              // Optimistic UI update — 'sr-saved' is the class the CSS at
              // .sr-icon-btn.sr-saved actually styles (red heart fill), and
              // is also what the initial-load check below adds. Previously
              // this toggled a different, unstyled class ('is-saved'), so
              // Firestore was updated correctly but the heart never visibly
              // changed — looked like the button did nothing.
              btn.classList.toggle('sr-saved', !alreadySaved);
              if (alreadySaved) _mpSavedCache.delete(listingId); else _mpSavedCache.add(listingId);

              try {
                const { doc, setDoc, deleteDoc, updateDoc, increment, serverTimestamp } =
                  await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                const db = await window.__dbReady;
                const userSaveRef = doc(db, 'users', user.uid, 'savedListings', listingId);
                const listingRef  = doc(db, 'listings', listingId);

                if (alreadySaved) {
                  await deleteDoc(userSaveRef);
                  await updateDoc(listingRef, { saves: increment(-1) });
                } else {
                  // Snapshot a bit of the listing alongside the save so the
                  // Favorites tab in the profile can render a full card
                  // instantly without an extra per-item listing fetch. This
                  // is just a display cache — clicking a favorite always
                  // opens the live listing doc, never this snapshot.
                  await setDoc(userSaveRef, {
                    listingId,
                    savedAt:   serverTimestamp(),
                    title:     listing.title || 'Untitled',
                    type:      listing.type || 'website',
                    image:     listing.images?.[2] || listing.imageCover || listing.images?.[0] || '',
                    price:     typeof listing.financials?.price === 'number' ? listing.financials.price : null,
                  });
                  await updateDoc(listingRef, { saves: increment(1) });
                }
              } catch (err) {
                console.error('[mpToggleSave] failed', err);
                // Revert optimistic state on failure
                btn.classList.toggle('sr-saved', alreadySaved);
                if (alreadySaved) _mpSavedCache.add(listingId); else _mpSavedCache.delete(listingId);
              }
            }


            // Still used by mpRenderCard to show the "Boosted" badge on a
            // card — this is just a badge flag, not part of the feed
            // ordering algorithm (which has been removed).
            function _isBoosted(listing) {
              const until = listing.boostedUntil;
              if (!until) return false;
              const ms = typeof until === 'number' ? until
                : (until.toMillis ? until.toMillis() : (until.seconds ? until.seconds * 1000 : 0));
              return ms > Date.now();
            }

            // "Premium Listing" badge — shown on cards whose owner is on a
            // paid plan. `listing.ownerPlan` is attached server-side by
            // /api/listings' listing.feed handler (it already does one
            // batched users/ lookup per feed page to run the boosted+premium
            // priority promotion, so stamping the plan onto each listing
            // there costs zero extra reads). This means the client never
            // needs to call mpGetSeller — which does a much heavier fetch,
            // including the seller's listings and follower count — just to
            // find out a plan string, and the value lives on the listing
            // object itself for the rest of the session (no re-fetch on
            // re-render, same as any other listing field).
            //
            // Colors mirror the pricing cards in index.html exactly (see
            // .lm-pricing-card[data-plan]): starter blue, growth lime, pro
            // purple. Free/unknown plans render no badge at all.
            const SR_PLAN_META = {
              starter: { label: 'Starter',  color: '#60a5fa' },
              growth:  { label: 'Growth',   color: '#a3e635' },
              pro:     { label: 'Pro',      color: '#d8b4fe' },
            };
            function _premiumBadgeHtml(listing) {
              const meta = SR_PLAN_META[listing.ownerPlan];
              if (!meta) return '';
              return `<div class="sr-premium-badge" style="--sr-premium-color:${meta.color};" title="Premium Listing · ${meta.label} plan">${STAR_SVG}<span>Premium · ${meta.label}</span></div>`;
            }

            // ── Native ad slots ──────────────────────────────────────────
            // Two ad sizes from the same network (invoke.js reads a global
            // `atOptions` at load time). Two units on one page would clobber
            // each other's atOptions if loaded directly in the parent page,
            // so each slot gets its own sandboxed same-origin-free iframe
            // (via srcdoc) with its own isolated `atOptions` + invoke.js —
            // no collision, and the ad network's own iframe styling never
            // leaks into the page since it's already inside our frame.
            //
            // Real impressions: invoke.js only reports an impression when
            // it actually executes in a real browser tab, so this must stay
            // client-side, rendered once per real scroll-in — never
            // fetched/replayed from a server. Hardcoding the two units here
            // produces exactly the same impression the ad network counts as
            // storing them in Firestore and injecting the same markup would;
            // the only difference would be being able to edit them without
            // a code change, which isn't needed right now.
            const AD_UNITS = {
              rect: {
                key: '02d530955f964bb754200c047d5cab26',
                width: 300, height: 250,
                invokeSrc: 'https://beavercolourfuldelinquent.com/02d530955f964bb754200c047d5cab26/invoke.js',
              },
              banner: {
                key: '837d8d50ffa851dddd18e0f1d01833aa',
                width: 320, height: 50,
                invokeSrc: 'https://beavercolourfuldelinquent.com/837d8d50ffa851dddd18e0f1d01833aa/invoke.js',
              },
            };

            function mpBuildAdCard(kind) {
              const unit = AD_UNITS[kind];
              if (!unit) return null;

              const slot = document.createElement('div');
              slot.className = 'sr-ad-slot' + (kind === 'banner' ? ' sr-ad-banner' : '');

              const iframe = document.createElement('iframe');
              iframe.width  = String(unit.width);
              iframe.height = String(unit.height);
              iframe.scrolling = 'no';
              iframe.title = 'Advertisement';
              iframe.setAttribute('loading', 'lazy');
              // srcdoc gives this ad unit its own separate `window`, so its
              // own atOptions/invoke.js never touches the parent page or
              // any other ad slot's atOptions on the same feed.
              iframe.srcdoc =
                '<!doctype html><html><head><meta charset="utf-8">' +
                '<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style>' +
                '</head><body>' +
                '<script>atOptions = ' + JSON.stringify({ key: unit.key, format: 'iframe', height: unit.height, width: unit.width, params: {} }) + ';<' + '/script>' +
                '<script src="' + unit.invokeSrc + '"><' + '/script>' +
                '</body></html>';

              slot.appendChild(iframe);
              return slot;
            }

            // Running counter of real listing cards rendered into the feed
            // so far (across pagination batches) — ad cadence is measured
            // against this, not the current batch, so "load more" continues
            // the same rhythm instead of restarting the count each time.
            let _mpListingsSinceReset = 0;

            const AD_CADENCE = { rect: 8, banner: 4 };

            function mpResetAdCounter() { _mpListingsSinceReset = 0; }

            function mpRenderCards(listings, fullReset = true) {
              if (fullReset) {
                Array.from(mpGrid.children).forEach(c => { if (!c.classList.contains('mp-state') && c.id !== 'mpLoadSentinel' && c.id !== 'mpLoadMoreSpinner') c.remove(); });
                mpResetAdCounter();
              }
              mpLoading.style.display = 'none';
              if (!listings.length && fullReset) { mpEmpty.style.display = 'flex'; return; }
              if (!listings.length) return;
              mpEmpty.style.display = 'none';

              const sentinel = document.getElementById('mpLoadSentinel');
              const spinner  = document.getElementById('mpLoadMoreSpinner');
              // insertBefore requires the anchor to be a direct child of mpGrid.
              // mpLoadSentinel/mpLoadMoreSpinner can live outside mpGrid in the
              // markup, so guard against that or insertBefore throws
              // "NotFoundError: node before which the new node is to be
              // inserted is not a child of this node".
              const anchor = (sentinel && sentinel.parentNode === mpGrid) ? sentinel
                           : (spinner && spinner.parentNode === mpGrid) ? spinner
                           : null;

              // Simple, synchronous render — no boosting, no shuffling, no
              // interleaving of listings themselves, no animation-frame
              // queue. Each listing becomes one card, appended in the order
              // it was fetched. A 300×250 ad slot is inserted every 8
              // listings and a 320×50 banner every 4 (so the banner also
              // lands on the midpoint between two rect ads), counted
              // against the running total across the whole session — not
              // restarted each "load more" batch. Individual card build
              // failures are caught so one bad listing can't take down the
              // whole render.
              const frag = document.createDocumentFragment();
              for (const listing of listings) {
                try {
                  const card = mpRenderCard(listing);
                  if (card) frag.appendChild(card);
                } catch (err) {
                  console.error('[mpRenderCard] failed to build card for listing', listing?.id, err);
                  continue;
                }

                _mpListingsSinceReset++;
                if (_mpListingsSinceReset % AD_CADENCE.rect === 0) {
                  const ad = mpBuildAdCard('rect');
                  if (ad) frag.appendChild(ad);
                } else if (_mpListingsSinceReset % AD_CADENCE.banner === 0) {
                  const ad = mpBuildAdCard('banner');
                  if (ad) frag.appendChild(ad);
                }
              }
              mpGrid.insertBefore(frag, anchor);
            }
            
            function _sectionHeader(type, count) {
              const isApp  = type === 'app';
              // SVG icons instead of emojis — neutral color, no per-type tint
              const iconSvg = isApp
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18" stroke-width="2"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polygon points="6,2 18,2 22,8 12,22 2,8"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="12" y1="2" x2="12" y2="8"/></svg>`;
              const title  = isApp ? 'Apps' : 'Games';
              const sub    = `${count} listing${count !== 1 ? 's' : ''} for sale`;
            
              const wrap = document.createElement('div');
              wrap.className = 'mp-section-header';
              wrap.style.gridColumn = '1 / -1';
              wrap.innerHTML = `
                <div class="mp-section-header-icon" style="background:rgba(255,255,255,.06);">${iconSvg}</div>
                <div class="mp-section-header-text">
                  <div class="mp-section-header-title">${title}</div>
                  <div class="mp-section-header-sub">${sub}</div>
                </div>
                <div class="mp-section-header-line"></div>`;
              return wrap;
            }
            
            // ── Star SVG helper ──
            function mpStars(rating, count) {
              const starSvg = (filled) => `<svg class="mp-star${filled?' on':''}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>`;
              const full = Math.floor(rating), half = rating - full >= 0.5 ? 1 : 0, empty = 5 - full - half;
              let html = '';
              for (let i=0;i<full;i++)  html += starSvg(true);
              for (let i=0;i<half;i++)  html += starSvg(true);
              for (let i=0;i<empty;i++) html += starSvg(false);
              html += `<span class="mp-star-count">(${count})</span>`;
              return html;
            }
            
            // ── Seller cache ──
            function srEscapeHtml(s) {
              return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
            }

            /* ═══════════════════════════════════════════════════════
               COPYABLE ERROR BOX — shared across the whole app
               ───────────────────────────────────────────────────────
               Any inline error anywhere (feedback modal, forms, deal
               chat, settings, etc.) should render through this instead
               of dropping raw text into a plain <div>. Plain text runs
               get visually merged with surrounding UI copy and, on some
               mobile browsers, become hard or impossible to select —
               exactly what happened with the Firestore index error.
               This gives every error its own bordered, monospace,
               selectable, scrollable container with an explicit copy
               button, so technical messages (stack traces, URLs, error
               codes) are always easy to grab and paste elsewhere.

               Usage:
                 window.__srfErrorBox(containerEl, message)
                 window.__srfErrorBox(containerEl, message, { title: "Couldn't load suggestions" })
                 window.__srfClearErrorBox(containerEl)
               ═══════════════════════════════════════════════════════ */
            (function () {
              let injected = false;
              function ensureStyles() {
                if (injected) return;
                injected = true;
                const style = document.createElement('style');
                style.textContent = `
                  .srf-errbox {
                    display: flex; flex-direction: column; gap: 8px;
                    background: #1a0f11; border: 1px solid rgba(255,107,107,.35);
                    border-radius: 10px; padding: 11px 12px; margin-top: 4px;
                  }
                  .srf-errbox-head {
                    display: flex; align-items: center; justify-content: space-between; gap: 8px;
                  }
                  .srf-errbox-title {
                    font-size: 12px; font-weight: 700; color: #ff8a8a;
                    font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                  }
                  .srf-errbox-copy {
                    display: flex; align-items: center; gap: 5px;
                    background: rgba(255,255,255,.08); border: none; border-radius: 7px;
                    color: rgba(255,255,255,.75); font-size: 11px; font-weight: 700;
                    font-family: inherit; padding: 5px 9px; cursor: pointer;
                    transition: background .15s, color .15s; flex-shrink: 0;
                  }
                  .srf-errbox-copy:hover { background: rgba(255,255,255,.16); color: #fff; }
                  .srf-errbox-copy.srf-copied { background: rgba(61,220,151,.18); color: #3ddc97; }
                  .srf-errbox-copy svg { width: 12px; height: 12px; flex-shrink: 0; }
                  .srf-errbox-body {
                    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                    font-size: 11.5px; line-height: 1.55; color: #ffb3b3;
                    white-space: pre-wrap; word-break: break-word;
                    max-height: 180px; overflow-y: auto;
                    -webkit-user-select: text; user-select: text; cursor: text;
                  }
                `;
                document.head.appendChild(style);
              }

              const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
              const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

              // Renders a copyable error box into `container` (an element,
              // or a container id string). Clears any prior content in it.
              window.__srfErrorBox = function (container, message, opts) {
                ensureStyles();
                const el = typeof container === 'string' ? document.getElementById(container) : container;
                if (!el) return;
                const title = (opts && opts.title) || 'Something went wrong';
                const text = String(message == null ? '' : message);

                el.innerHTML = '';
                const box = document.createElement('div');
                box.className = 'srf-errbox';

                const head = document.createElement('div');
                head.className = 'srf-errbox-head';
                const titleEl = document.createElement('div');
                titleEl.className = 'srf-errbox-title';
                titleEl.textContent = title;
                const copyBtn = document.createElement('button');
                copyBtn.type = 'button';
                copyBtn.className = 'srf-errbox-copy';
                copyBtn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
                head.appendChild(titleEl);
                head.appendChild(copyBtn);

                const body = document.createElement('div');
                body.className = 'srf-errbox-body';
                body.textContent = text; // textContent — never trust error strings as HTML

                copyBtn.addEventListener('click', async () => {
                  try {
                    if (navigator.clipboard?.writeText) {
                      await navigator.clipboard.writeText(text);
                    } else {
                      // Fallback for older/webview browsers without Clipboard API
                      const ta = document.createElement('textarea');
                      ta.value = text;
                      ta.style.position = 'fixed';
                      ta.style.opacity = '0';
                      document.body.appendChild(ta);
                      ta.focus(); ta.select();
                      document.execCommand('copy');
                      document.body.removeChild(ta);
                    }
                    copyBtn.classList.add('srf-copied');
                    copyBtn.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
                    setTimeout(() => {
                      copyBtn.classList.remove('srf-copied');
                      copyBtn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
                    }, 1600);
                  } catch (e) {
                    console.error('[srf-errbox] copy failed:', e);
                  }
                });

                box.appendChild(head);
                box.appendChild(body);
                el.appendChild(box);
              };

              window.__srfClearErrorBox = function (container) {
                const el = typeof container === 'string' ? document.getElementById(container) : container;
                if (el) el.innerHTML = '';
              };
            })();

            /* ═══════════════════════════════════════════════════════
               SELLER TRUST BADGES
               Single source of truth for the verified checkmark + deal-
               tier badge shown next to a seller's name everywhere it
               renders. Call sellerBadgesHtml(seller) anywhere seller.username
               is rendered — it reads seller.followerCount and
               seller.dealsCompleted (both populated by mpGetSeller) and
               returns an HTML string, or '' if the seller qualifies for
               nothing yet.
            ═══════════════════════════════════════════════════════ */
            const SR_VERIFIED_FOLLOWER_THRESHOLD = 1000;

            // Ordered low → high; first non-matching stops the scan, so
            // check from the top down when picking a seller's tier.
            const SR_DEAL_TIERS = [
              { key: 'legendary', min: 100, label: 'Legendary Seller',  color: '#f2b632' },
              { key: 'gold',      min: 50,  label: 'Gold Seller',       color: '#f2b632' },
              { key: 'silver',    min: 20,  label: 'Silver Seller',     color: '#c0c5ce' },
              { key: 'bronze',    min: 5,   label: 'Bronze Seller',     color: '#cd7f32' },
            ];
            function srDealTierFor(dealsCompleted) {
              const n = Number(dealsCompleted) || 0;
              return SR_DEAL_TIERS.find(t => n >= t.min) || null;
            }

            const srVerifiedCheckSvg = `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12"/><path d="M7 12.5l3 3 7-7" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

            // Small per-tier glyphs — medal shapes for bronze/silver/gold,
            // a crown for legendary (paired separately with the gold
            // verified check + count chip, per srBadgesHtml below).
            const SR_TIER_ICONS = {
              bronze: `<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="10" r="7"/><path d="M8.5 16 6.5 22l5.5-3 5.5 3-2-6" fill="none" stroke="currentColor" stroke-width="0" /></svg>`,
              silver: `<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="10" r="7"/><path d="M8.5 16 6.5 22l5.5-3 5.5 3-2-6" fill="none" stroke="currentColor" stroke-width="0" /></svg>`,
              gold:   `<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="10" r="7"/><path d="M8.5 16 6.5 22l5.5-3 5.5 3-2-6" fill="none" stroke="currentColor" stroke-width="0" /></svg>`,
              legendary: `<svg width="13" height="13" viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z"/><circle cx="12" cy="19.5" r="1.4"/></svg>`,
            };

            // Builds the full badge cluster HTML for a seller. Order:
            // premium plan check (lime, if on a paid plan) → verified check
            // (blue or gold, earned via followers/deals) → deal-tier badge
            // with count. Legendary sellers get all: gold verified + trophy
            // badge + exact count chip, exactly as specced.
            const SR_PAID_PLANS = ['starter', 'growth', 'pro'];
            function sellerBadgesHtml(seller) {
              if (!seller) return '';
              const followers = Number(seller.followerCount) || 0;
              const deals = Number(seller.dealsCompleted) || 0;
              const tier = srDealTierFor(deals);
              const isVerifiedByFollowers = followers >= SR_VERIFIED_FOLLOWER_THRESHOLD;
              const isLegendary = tier?.key === 'legendary';
              const isPremiumPlan = SR_PAID_PLANS.includes(seller.plan);

              let out = '';

              // Premium plan checkmark — lime, earned by subscribing to
              // Starter/Growth/Pro. Independent of the follower/deal-based
              // verified badge below, so a seller can show both.
              if (isPremiumPlan) {
                const planLabel = seller.plan.charAt(0).toUpperCase() + seller.plan.slice(1);
                const title = `Verified · ${planLabel} plan`;
                out += `<span class="sr-badge sr-badge-verified-premium" title="${title}" aria-label="${title}">${srVerifiedCheckSvg}</span>`;
              }

              // Verified checkmark: gold if Legendary tier (100+ deals),
              // otherwise blue if the 1k-follower threshold is met. A
              // Legendary seller always shows gold verified even without
              // 1k followers — the badge is earned by proven deal volume.
              if (isLegendary || isVerifiedByFollowers) {
                const cls = isLegendary ? 'sr-badge-verified-gold' : 'sr-badge-verified-blue';
                const title = isLegendary ? 'Verified · Legendary Seller' : `Verified · ${followers.toLocaleString()}+ followers`;
                out += `<span class="sr-badge ${cls}" title="${title}" aria-label="${title}">${srVerifiedCheckSvg}</span>`;
              }

              // Deal-tier badge with exact count.
              if (tier) {
                const title = `${tier.label} · ${deals.toLocaleString()} deals completed`;
                out += `<span class="sr-badge sr-badge-tier sr-badge-tier-${tier.key}" title="${title}" aria-label="${title}">${SR_TIER_ICONS[tier.key]}<span class="sr-badge-tier-count">${deals.toLocaleString()}</span></span>`;
              }

              return out ? `<span class="sr-badges">${out}</span>` : '';
            }

            const _sellerCache = {};
            // Hardcoded fallback shown in the seller profile's bio row whenever
            // the seller has no bio set (or has chosen not to show it). Kept as
            // a single constant so the bio section always renders something
            // instead of appearing blank/missing under the stat cards.
            const SP_NO_BIO_PLACEHOLDER = 'This seller hasn\'t added a bio yet.';

            async function mpGetSeller(uid) {
              if (!uid) return null;
              if (_sellerCache[uid]) return _sellerCache[uid];
              try {
                const { doc, getDoc, collection, query, where, orderBy, getDocs, limit, getCountFromServer } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                const snap = await getDoc(doc(window.__db, 'users', uid));
                const d = snap.exists() ? snap.data() : {};
                // Fetch seller's listings
                // NOTE: deliberately NOT using orderBy('createdAt') here — that
                // turns this into a compound query (ownerId == + status == +
                // orderBy createdAt) which requires a Firestore composite index.
                // Without that index Firestore throws, and since this was
                // previously wrapped in a bare catch(_) {}, the error was
                // swallowed and the seller's listings silently rendered as
                // empty even when the seller had active listings. Sorting
                // client-side avoids the index requirement entirely.
                let sellerListings = [];
                try {
                  const lq = query(collection(window.__db,'listings'), where('ownerId','==',uid), where('status','==','active'), limit(40));
                  const lsnap = await getDocs(lq);
                  lsnap.forEach(ld => sellerListings.push({ id: ld.id, ...ld.data() }));
                  sellerListings.sort((a, b) => {
                    const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
                    const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
                    return bt - at;
                  });
                  sellerListings = sellerListings.slice(0, 20);
                } catch(err) {
                  console.error('[mpGetSeller] failed to load seller listings for', uid, err);
                }
                // Fetch follower count
                let followerCount = 0;
                try {
                  const fc = await getCountFromServer(collection(window.__db, 'users', uid, 'followers'));
                  followerCount = fc.data().count;
                } catch(_) {}
                // Lifetime completed-deals count (for the deal-tier trust
                // badge). This now lives directly on the user doc as
                // dealsCompleted — deal.js's _releaseEscrowForRoom bumps it
                // atomically (FieldValue.increment) every time a deal
                // completes, so it's already sitting in `d` from the
                // getDoc() above and costs nothing extra to read.
                //
                // Fallback: sellers who completed deals before this field
                // existed won't have it yet. For them (and only them) we
                // do a one-time aggregation via get-seller-stats, which
                // scans their deals subcollection server-side. This costs
                // one extra request the first time such a seller is ever
                // viewed post-launch, never again after — mpGetSeller's
                // cache holds the result for the rest of the session, and
                // once dealsCompleted is backfilled server-side (or the
                // seller completes a new deal) this branch stops firing
                // for them entirely.
                let dealsCompleted = typeof d.dealsCompleted === 'number' ? d.dealsCompleted : null;
                if (dealsCompleted === null) {
                  dealsCompleted = 0;
                  try {
                    const statsResp = await fetch('/api/deal', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'get-seller-stats', sellerUid: uid }),
                    });
                    const statsOut = await statsResp.json();
                    if (statsResp.ok && statsOut.ok) dealsCompleted = statsOut.lifetimeDeals || 0;
                  } catch(_) {}
                }
                const joinedAt = d.createdAt
                  ? (d.createdAt.toDate ? d.createdAt.toDate() : new Date(d.createdAt))
                  : null;
                const seller = {
                  uid,
                  username:      d.username || d.displayName || d.email?.split('@')[0] || 'Anonymous',
                  profilePic:    d.profilePic || '',
                  plan:          d.plan || 'free',
                  rating:        typeof d.rating === 'number' ? d.rating : 0,
                  ratingCount:   typeof d.ratingCount === 'number' ? d.ratingCount : 0,
                  bio:           d.bio || '',
                  contactEmail:  d.contactEmail || '',
                  website:       d.website || d.websiteUrl || '',
                  twitter:       d.twitter || d.twitterUrl || '',
                  github:        d.github || d.githubUrl || '',
                  linkedin:      d.linkedin || d.linkedinUrl || '',
                  joinedAt,
                  listings:      sellerListings,
                  followerCount,
                  dealsCompleted,
                  // Privacy settings
                  profileVisibility: d.profileVisibility || 'public',
                  showEmail:         d.showEmail === true,
                  showBio:           d.showBio !== false,
                  showSocial:        d.showSocial !== false,
                };
                _sellerCache[uid] = seller;
                return seller;
              } catch { return null; }
            }
            
            /* ═══════════════════════════════════════════════════════
               CARD RENDERERS
            ═══════════════════════════════════════════════════════ */
            
            // Abbreviate large financial values so they stay within small card cells
            function fmtFinVal(n) {
              if (n === null || n === undefined) return '—';
              if (Math.abs(n) >= 1000000) return '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
              if (Math.abs(n) >= 10000)   return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
              return '$' + n.toLocaleString();
            }
            
// ── Listing analytics beacon (impression / view) ──
// Fire-and-forget POST to /api/listings — never blocks or throws into the
// caller, since a failed analytics ping should never break browsing.
async function _mpTrackListing(action, listingId) {
  if (!listingId) return;
  try {
    const user = window.__auth && window.__auth.currentUser;
    const idToken = user ? await user.getIdToken() : null;
    await fetch('/api/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, idToken, listingId }),
    });
  } catch (err) {
    console.error('[_mpTrackListing]', action, err.message);
  }
}

// Per-card impression observer — fires `listing.impression` once per card
// element the first time it's actually scrolled into view (not just
// rendered into the DOM off-screen). Each card gets its own observer
// instance, disconnected after the first hit so a card re-entering the
// viewport on scroll-back doesn't double count.
function _mpObserveImpression(cardEl, listingId) {
  if (!listingId || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) {
      io.disconnect();
      _mpTrackListing('listing.impression', listingId);
    }
  }, { threshold: 0.5 });
  io.observe(cardEl);
}

function mpRenderCard(listing) {
              const type  = listing.type || 'website';
              const isApp  = type === 'app';
              const isGame = type === 'game';
              const isSite = !isApp && !isGame;

              const fin   = listing.financials || {};
              const title = listing.title || 'Untitled';
              const desc  = listing.description || '';
              const price = typeof fin.price === 'number' ? `$${fin.price.toLocaleString()}` : 'Make offer';
              const sellerHandle = listing.ownerEmail?.split('@')[0] || 'Anonymous';
              const uid_str = listing.id || Math.random().toString(36).slice(2);

              let card;

              /* ════════════════════════════════════════════════════
                 WEBSITE LISTING — sr-site
                 Horizontal split card: screenshot on the left as a
                 fixed-width panel, all copy on the right. Square
                 corners on the media panel, rounded only on the
                 outer shell. Cyan identity marker.
              ════════════════════════════════════════════════════ */
              if (isSite) {
                const mainImg  = listing.images?.[2] || listing.imageCover || listing.images?.[0]
                  || 'https://placehold.co/1280x720/0d0d14/444?text=No+Preview';
                const subImg1  = listing.images?.[0] || '';
                const subImg2  = listing.images?.[1] || '';
                const isTemplate = listing.isTemplate || false;
                const revenue  = typeof fin.revenue  === 'number' ? `$${fin.revenue.toLocaleString()}`  : '—';
                const expenses = typeof fin.expenses === 'number' ? `$${fin.expenses.toLocaleString()}` : '—';
                const profit   = typeof fin.profit   === 'number' ? fin.profit : null;
                const profitStr = profit !== null ? `$${Math.abs(profit).toLocaleString()}` : '—';
                const profitCls = profit !== null ? (profit >= 0 ? 'sr-pos' : 'sr-neg') : '';
                const tech  = listing.tech || {};
                const pills = [tech.frontend, tech.backend, tech.database, tech.monetization].filter(Boolean);
                const techStr = pills.slice(0, 3).join(' · ');

                card = document.createElement('div');
                card.className = 'sr-site' + (_isBoosted(listing) ? ' sr-boosted' : '') + (SR_PLAN_META[listing.ownerPlan] ? ' sr-premium' : '');
                card.dataset.type = 'website';
                card.innerHTML = `
                  ${_isBoosted(listing) ? `<div class="sr-boost">${FLAME_SVG}<span>Boosted</span></div>` : ''}
                  ${_premiumBadgeHtml(listing)}
                  <div class="sr-site-media">
                    <div class="sr-site-media-main" data-src="${mainImg}">
                      <img src="${mainImg}" alt="${title}" loading="lazy"
                           onerror="this.src='https://placehold.co/1280x720/0d0d14/444?text=No+Preview'">
                      <div class="sr-site-tag">Site${isTemplate ? ' · Template' : ''}</div>
                    </div>
                    <div class="sr-site-media-sub">
                      <div class="sr-site-media-thumb" data-src="${subImg1}">
                        <img src="${subImg1}" alt="${title} screenshot 2" loading="lazy"
                             onerror="this.style.visibility='hidden'">
                      </div>
                      <div class="sr-site-media-thumb" data-src="${subImg2}">
                        <img src="${subImg2}" alt="${title} screenshot 3" loading="lazy"
                             onerror="this.style.visibility='hidden'">
                      </div>
                    </div>
                  </div>
                  <div class="sr-site-main">
                    <div class="sr-site-headline">
                      <h3 class="sr-site-title">${title}</h3>
                      <div class="sr-site-price">${price}</div>
                    </div>
                    <p class="sr-site-desc">${desc.slice(0,110)}${desc.length>110?'…':''}</p>
                    <div class="sr-site-stats">
                      <div class="sr-stat"><span class="sr-stat-k">Revenue</span><span class="sr-stat-v">${revenue}</span></div>
                      <div class="sr-stat"><span class="sr-stat-k">Expenses</span><span class="sr-stat-v">${expenses}</span></div>
                      <div class="sr-stat"><span class="sr-stat-k">Profit</span><span class="sr-stat-v ${profitCls}">${profitStr}</span></div>
                    </div>
                    ${techStr ? `<div class="sr-site-tech">${techStr}</div>` : ''}
                    <div class="sr-site-foot">
                      <div class="sr-seller" id="mp-seller-${uid_str}">
                        <div class="sr-av" data-init="${sellerHandle.charAt(0).toUpperCase()}">${sellerHandle.charAt(0).toUpperCase()}</div>
                        <div class="sr-seller-txt">
                          <span class="sr-seller-name">${sellerHandle}</span>
                          <span class="sr-seller-stars">${mpStars(0,0)}</span>
                        </div>
                      </div>
                      <div class="sr-site-actions">
                        <button type="button" class="sr-icon-btn sr-save-btn mp-save-btn" aria-label="Save">${HEART_SVG}</button>
                        <button class="sr-ghost-btn mp-view-seller-btn">Seller</button>
                        <button class="sr-btn sr-btn-site mp-view-btn">Open site</button>
                      </div>
                    </div>
                  </div>`;

                if (listing.ownerId) {
                  mpGetSeller(listing.ownerId).then(seller => {
                    if (!seller) return;
                    const strip = card.querySelector('.sr-seller');
                    if (!strip) return;
                    const av   = strip.querySelector('.sr-av');
                    const name = strip.querySelector('.sr-seller-name');
                    const stars= strip.querySelector('.sr-seller-stars');
                    if (seller.profilePic) {
                      av.innerHTML = `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`;
                    } else { av.textContent = seller.username.charAt(0).toUpperCase(); }
                    name.innerHTML = '<span class="sr-seller-name-text">' + srEscapeHtml(seller.username) + '</span>' + sellerBadgesHtml(seller);
                    stars.innerHTML  = mpStars(seller.rating, seller.ratingCount);
                  });
                }

                card.querySelector('.mp-view-btn').addEventListener('click', e => { e.stopPropagation(); mpOpenModal(listing); });
                card.querySelector('.mp-view-seller-btn').addEventListener('click', e => { e.stopPropagation(); mpOpenSellerModal(listing.ownerId, listing); });
                const _siteSaveBtn = card.querySelector('.mp-save-btn');
                if (_siteSaveBtn) {
                  _mpLoadSavedCache().then(cache => { if (cache.has(listing.id)) _siteSaveBtn.classList.add('sr-saved'); });
                  _siteSaveBtn.addEventListener('click', e => { e.stopPropagation(); mpToggleSave(listing, _siteSaveBtn); });
                }
              }

              /* ════════════════════════════════════════════════════
                 APP LISTING — sr-app
                 Stacked card: square icon top-left, name/category
                 beside it, full-width stat strip, screenshots as a
                 filmstrip. Violet identity marker. Distinct pill CTA
                 shape (fully rounded) vs. website's rectangular CTA.
              ════════════════════════════════════════════════════ */
              else if (isApp) {
                const iconSrc = listing.appIcon || listing.images?.[0] || listing.imageCover
                  || `https://placehold.co/128x128/1a1026/a78bfa?text=${encodeURIComponent(title.slice(0,2))}`;
                const category = listing.category || listing.tech?.frontend || listing.tech?.backend || 'App';
                const revenue  = typeof fin.revenue  === 'number' ? fmtFinVal(fin.revenue)  : '—';
                const expenses = typeof fin.expenses === 'number' ? fmtFinVal(fin.expenses) : '—';
                const profit   = typeof fin.profit   === 'number' ? fin.profit : null;
                const profitStr = profit !== null ? fmtFinVal(Math.abs(profit)) : '—';
                const profitCls = profit !== null ? (profit >= 0 ? 'sr-pos' : 'sr-neg') : '';
                const uid_str_app = listing.id || Math.random().toString(36).slice(2);
                const desc = (listing.description || listing.tagline || '').trim();
                const shots = (listing.images || []).filter(Boolean).slice(0,3);

                // Platform badges — hardcoded to always show on every app card
                // (App Store, Play Store, Web), regardless of what the listing
                // has saved. Same glyphs used in the listing detail modal.
                const platformBadgesHtml = `
                  <span class="sr-app-platform-badge sr-badge-ios" title="App Store" aria-label="App Store">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                  </span>
                  <span class="sr-app-platform-badge sr-badge-android" title="Google Play" aria-label="Google Play">
                    <svg width="13" height="13" viewBox="0 0 512 512">
                      <path fill="#00d2ff" d="M47.7 21.4C40 29.6 36 41.2 36 55.9v400.2c0 14.7 4 26.3 11.7 34.5l1.9 1.9L273 268.1v-4.7L49.6 19.5l-1.9 1.9z"/>
                      <path fill="#00f076" d="M347.5 342.5l-74.9-74.9v-4.7l74.9-74.9 1.7 1L438 234.6c25.6 14.5 25.6 38.3 0 52.9l-89.8 44.9-.7.1z"/>
                      <path fill="#ff3a44" d="M349.2 341.5L273 265.3 47.7 490.6c8.3 8.7 22 9.8 37.4 1.1l264.1-150.2"/>
                      <path fill="#ffcf00" d="M349.2 189.1L85.1 38.9c-15.4-8.7-29.1-7.6-37.4 1.1L273 265.3l76.2-76.2z"/>
                    </svg>
                  </span>
                  <span class="sr-app-platform-badge sr-badge-web" title="Web App" aria-label="Web App"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 010 20M2 12h20" stroke-linecap="round"/></svg></span>`;

                card = document.createElement('div');
                card.className = 'sr-app' + (_isBoosted(listing) ? ' sr-boosted' : '') + (SR_PLAN_META[listing.ownerPlan] ? ' sr-premium' : '');
                card.dataset.type = 'app';
                card.innerHTML = `
                  ${_isBoosted(listing) ? `<div class="sr-boost">${FLAME_SVG}<span>Boosted</span></div>` : ''}
                  ${_premiumBadgeHtml(listing)}
                  <div class="sr-app-head">
                    <div class="sr-app-icon">
                      <img src="${iconSrc}" alt="${title}" loading="lazy"
                           onerror="this.src='https://placehold.co/128x128/1a1026/a78bfa?text=${encodeURIComponent(title.slice(0,2))}'">
                      <div class="sr-app-platform-row">${platformBadgesHtml}</div>
                    </div>
                    <div class="sr-app-head-txt">
                      <div class="sr-app-name-row">
                        <h3 class="sr-app-name">${title}</h3>
                        <span class="sr-app-cat">${category}</span>
                      </div>
                      ${desc ? `<p class="sr-app-desc">${desc.slice(0,90)}${desc.length>90?'…':''}</p>` : ''}
                    </div>
                    <div class="sr-app-price">${price}</div>
                  </div>
                  <div class="sr-app-stats">
                    <div class="sr-stat"><span class="sr-stat-k">Revenue</span><span class="sr-stat-v">${revenue}</span></div>
                    <div class="sr-stat"><span class="sr-stat-k">Expenses</span><span class="sr-stat-v sr-neg">${expenses}</span></div>
                    <div class="sr-stat"><span class="sr-stat-k">Profit</span><span class="sr-stat-v ${profitCls}">${profitStr}</span></div>
                  </div>
                  ${shots.length ? `
                  <div class="sr-app-shots">
                    ${shots.map(src => `<img src="${src}" alt="${title} screenshot" loading="lazy" onerror="this.style.display='none'">`).join('')}
                  </div>` : ''}
                  <div class="sr-app-foot">
                    <div class="sr-seller" id="mp-app-seller-${uid_str_app}">
                      <div class="sr-av" data-init="${sellerHandle.charAt(0).toUpperCase()}">${sellerHandle.charAt(0).toUpperCase()}</div>
                      <div class="sr-seller-txt">
                        <span class="sr-seller-name">${sellerHandle}</span>
                        <span class="sr-seller-stars">${mpStars(0,0)}</span>
                      </div>
                      <button type="button" class="sr-text-link mp-view-seller-btn">View seller</button>
                    </div>
                    <div class="sr-app-actions">
                      <button type="button" class="sr-icon-btn sr-save-btn mp-save-btn" aria-label="Save">${HEART_SVG}</button>
                      <button class="sr-pill-btn sr-pill-app mp-view-btn">View app</button>
                    </div>
                  </div>`;

                if (listing.ownerId) {
                  mpGetSeller(listing.ownerId).then(seller => {
                    if (!seller) return;
                    const strip = card.querySelector('.sr-seller');
                    if (!strip) return;
                    const av   = strip.querySelector('.sr-av');
                    const name = strip.querySelector('.sr-seller-name');
                    const stars= strip.querySelector('.sr-seller-stars');
                    if (seller.profilePic) {
                      av.innerHTML = `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`;
                    } else { av.textContent = seller.username.charAt(0).toUpperCase(); }
                    name.innerHTML = '<span class="sr-seller-name-text">' + srEscapeHtml(seller.username) + '</span>' + sellerBadgesHtml(seller);
                    stars.innerHTML  = mpStars(seller.rating, seller.ratingCount);
                  });
                }

                card.addEventListener('click', () => mpOpenModal(listing));
                card.querySelector('.mp-view-btn').addEventListener('click', e => { e.stopPropagation(); mpOpenModal(listing); });
                card.querySelector('.mp-view-seller-btn').addEventListener('click', e => { e.stopPropagation(); mpOpenSellerModal(listing.ownerId, listing); });
                const saveBtn = card.querySelector('.mp-save-btn');
                if (saveBtn) {
                  _mpLoadSavedCache().then(cache => { if (cache.has(listing.id)) saveBtn.classList.add('sr-saved'); });
                  saveBtn.addEventListener('click', e => { e.stopPropagation(); mpToggleSave(listing, saveBtn); });
                }
              }

              /* ════════════════════════════════════════════════════
                 GAME LISTING — sr-game
                 Full-bleed banner card with a play glyph and the
                 title/price docked directly on the image edge (no
                 gradient veil), then a compact stat + CTA footer.
                 Amber identity marker. CTA is a solid filled block,
                 unlike site's outline and app's pill.
              ════════════════════════════════════════════════════ */
              else {
                const banner = listing.images?.[2] || listing.imageCover || listing.images?.[0]
                  || `https://placehold.co/800x450/0a0a0f/f59e0b?text=${encodeURIComponent(title.slice(0,2))}`;
                const genre  = listing.category || listing.tech?.frontend || listing.tech?.backend || 'Game';
                const revenue  = typeof fin.revenue  === 'number' ? fmtFinVal(fin.revenue)  : '—';
                const expenses = typeof fin.expenses === 'number' ? fmtFinVal(fin.expenses) : '—';
                const profit   = typeof fin.profit   === 'number' ? fin.profit : null;
                const profitStr = profit !== null ? fmtFinVal(Math.abs(profit)) : '—';
                const profitCls = profit !== null ? (profit >= 0 ? 'sr-pos' : 'sr-neg') : '';
                const uid_str_game = listing.id || Math.random().toString(36).slice(2);

                card = document.createElement('div');
                card.className = 'sr-game' + (_isBoosted(listing) ? ' sr-boosted' : '') + (SR_PLAN_META[listing.ownerPlan] ? ' sr-premium' : '');
                card.dataset.type = 'game';
                card.innerHTML = `
                  ${_isBoosted(listing) ? `<div class="sr-boost">${FLAME_SVG}<span>Boosted</span></div>` : ''}
                  ${_premiumBadgeHtml(listing)}
                  <div class="sr-game-media">
                    <img src="${banner}" alt="${title}" loading="lazy"
                         onerror="this.src='https://placehold.co/800x450/0a0a0f/f59e0b?text=Game'">
                    <div class="sr-game-badge" aria-label="Game" title="Game">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 12h4M8 10v4"/>
                        <circle cx="15.5" cy="10.5" r="0.9" fill="currentColor" stroke="none"/>
                        <circle cx="17.5" cy="13.5" r="0.9" fill="currentColor" stroke="none"/>
                        <path d="M17 6H7a5 5 0 00-4.9 6.02l.7 3.5A2.5 2.5 0 005.25 17.5c.7 0 1.36-.31 1.8-.86L8.5 15h7l1.45 1.64c.44.55 1.1.86 1.8.86a2.5 2.5 0 002.45-1.98l.7-3.5A5 5 0 0017 6z"/>
                      </svg>
                    </div>
                    <button type="button" class="sr-game-play" aria-label="Preview">
                      <svg width="16" height="16" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                    <span class="sr-game-genre">${genre}</span>
                  </div>
                  <div class="sr-game-bar">
                    <h3 class="sr-game-title">${title}</h3>
                    <span class="sr-game-price">${price}</span>
                  </div>
                  <div class="sr-game-stats">
                    <div class="sr-stat"><span class="sr-stat-k">Revenue</span><span class="sr-stat-v">${revenue}</span></div>
                    <div class="sr-stat"><span class="sr-stat-k">Expenses</span><span class="sr-stat-v">${expenses}</span></div>
                    <div class="sr-stat"><span class="sr-stat-k">Profit</span><span class="sr-stat-v ${profitCls}">${profitStr}</span></div>
                  </div>
                  <div class="sr-game-foot">
                    <div class="sr-seller" id="mp-game-seller-${uid_str_game}">
                      <div class="sr-av" data-init="${sellerHandle.charAt(0).toUpperCase()}">${sellerHandle.charAt(0).toUpperCase()}</div>
                      <div class="sr-seller-txt">
                        <span class="sr-seller-name">${sellerHandle}</span>
                        <span class="sr-seller-stars">${mpStars(0,0)}</span>
                      </div>
                      <button type="button" class="sr-text-link mp-view-seller-btn">View seller</button>
                    </div>
                    <div class="sr-game-actions">
                      <button type="button" class="sr-icon-btn sr-save-btn mp-save-btn" aria-label="Save">${HEART_SVG}</button>
                      <button class="sr-btn sr-btn-game mp-view-btn">Play &amp; buy</button>
                    </div>
                  </div>`;

                if (listing.ownerId) {
                  mpGetSeller(listing.ownerId).then(seller => {
                    if (!seller) return;
                    const strip = card.querySelector('.sr-seller');
                    if (!strip) return;
                    const av   = strip.querySelector('.sr-av');
                    const name = strip.querySelector('.sr-seller-name');
                    const stars= strip.querySelector('.sr-seller-stars');
                    if (seller.profilePic) {
                      av.innerHTML = `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`;
                    } else { av.textContent = seller.username.charAt(0).toUpperCase(); }
                    name.innerHTML = '<span class="sr-seller-name-text">' + srEscapeHtml(seller.username) + '</span>' + sellerBadgesHtml(seller);
                    stars.innerHTML  = mpStars(seller.rating, seller.ratingCount);
                  });
                }

                card.addEventListener('click', () => mpOpenModal(listing));
                card.querySelector('.mp-view-btn').addEventListener('click', e => { e.stopPropagation(); mpOpenModal(listing); });
                card.querySelector('.mp-view-seller-btn').addEventListener('click', e => { e.stopPropagation(); mpOpenSellerModal(listing.ownerId, listing); });
                const _gameSaveBtn = card.querySelector('.mp-save-btn');
                if (_gameSaveBtn) {
                  _mpLoadSavedCache().then(cache => { if (cache.has(listing.id)) _gameSaveBtn.classList.add('sr-saved'); });
                  _gameSaveBtn.addEventListener('click', e => { e.stopPropagation(); mpToggleSave(listing, _gameSaveBtn); });
                }
              }

              _mpObserveImpression(card, listing.id);

              return card;
            }
            
            // ── Listing detail modal ──
            let _currentListing = null; // track open listing for deal popup
            
            
      // ── Transfer method renderer (shared across all listing types) ──
      const _TM_LABELS = {
        'domain_push': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 010 20M2 12h20"/></svg>', l:'Domain Push' },
        'zip_download': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', l:'Full Site ZIP' },
        'cpanel': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>', l:'cPanel Migration' },
        'github': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>', l:'GitHub / GitLab Transfer' },
        'hosting_handover': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>', l:'Hosting Handover' },
        'db_dump': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>', l:'Database Dump (.sql)' },
        'ftp': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>', l:'FTP Credentials' },
        'site_builder': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>', l:'Site Builder Transfer' },
        'escrow_migration': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>', l:'Escrow Migration' },
        'license_key': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>', l:'License Key' },
        'apk_ipa': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>', l:'APK / IPA Download' },
        'app_store_connect': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2z"/><path d="M8 12l2.5 2.5L16 9"/></svg>', l:'App Store Connect' },
        'play_console': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><polygon points="5 3 19 12 5 21 5 3"/></svg>', l:'Google Play Console' },
        'credentials': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>', l:'Account Credentials' },
        'qr_code': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="3" height="3"/></svg>', l:'QR Code' },
        'api_key': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>', l:'API Key Delivery' },
        'steam_key': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>', l:'Steam Key' },
        'direct_download': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', l:'Direct Download' },
        'account_handover': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>', l:'Account Handover' },
        'gift_code': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/></svg>', l:'Gift Code' },
        'console_code': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>', l:'Console Store Code' },
        'google_play_games': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><polygon points="5 3 19 12 5 21 5 3"/></svg>', l:'Google Play Games' },
        'launcher': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.95C18.88 4 12 4 12 4s-6.88 0-8.59.47A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.95C5.12 20 12 20 12 20s6.88 0 8.59-.47a2.78 2.78 0 001.95-1.95A29 29 0 0023 12a29 29 0 00-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02"/></svg>', l:'Launcher Transfer' },
        'browser_login': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 010 20M2 12h20"/></svg>', l:'Browser Login' },
        'html_css_js': { s:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.8;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>', l:'HTML/CSS/JS Files ⚡ Fastest' },
      };

      // Resolves a listing build file's storagePath into a fresh, working
      // signed URL on demand (binary build files — apk/aab/obb/apks/xapk/
      // ipa — never get a permanent url, only a storagePath; see storage.js
      // TRANSFER_FILE_EXTS and listings.js's listing.file-url action).
      // Called from the onclick handler rendered into each build-file row
      // that only has a storagePath (no ready `url`). No auth required —
      // listing.file-url is a public action, so this works for signed-out
      // visitors browsing the marketplace too.
      window.__downloadListingBuildFile = async function(listingId, storagePath, btnEl) {
        if (!storagePath) return;
        const originalHtml = btnEl.innerHTML;
        btnEl.disabled = true;
        btnEl.innerHTML = 'Preparing…';
        try {
          const user = window.__auth && window.__auth.currentUser;
          const idToken = user ? await user.getIdToken() : null;
          const resp = await fetch('/api/listings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'listing.file-url', idToken, listingId, storagePath }),
          });
          const json = await resp.json();
          if (!resp.ok || !json.ok) throw new Error(json?.error?.message || 'Could not generate download link');
          window.open(json.data.url, '_blank', 'noopener');
        } catch (err) {
          console.error('[downloadListingBuildFile]', err.message);
          if (typeof toast === 'function') toast(err.message || 'Download failed — please try again.');
        } finally {
          btnEl.disabled = false;
          btnEl.innerHTML = originalHtml;
        }
      };

      function _buildTransferMethodsHtml(methods, accentColor) {
        if (!methods || methods.length === 0) return '';
        const pills = methods.map(m => {
          const info = _TM_LABELS[m] || { s:'', l: m.replace(/_/g,' ') };
          return `<span class="mp-transfer-pill" style="--tp-accent:${accentColor};">${info.s}${info.l}</span>`;
        }).join('');
        return `
          <div class="modal-section mp-transfer-section">
            <div class="modal-section-title mp-transfer-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              How You'll Receive This
            </div>
            <p class="mp-transfer-note">The seller will deliver via one or more of these methods:</p>
            <div class="mp-transfer-pills">${pills}</div>
          </div>`;
      }

      function _buildAttachedRepoHtml(repo, accentColor) {
        if (!repo || !repo.fullName) return '';
        const safeName = String(repo.fullName).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        const safeLang = repo.language ? String(repo.language).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : '';
        return `
          <div class="modal-section mp-repo-section">
            <div class="modal-section-title with-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="${accentColor}" stroke="none"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
              GitHub Repository
            </div>
            <a href="${repo.htmlUrl || '#'}" target="_blank" rel="noopener noreferrer" class="mp-repo-attached-card" style="--repo-accent:${accentColor};">
              <div class="mp-repo-attached-info">
                <span class="mp-repo-attached-name">${safeName}</span>
                <span class="mp-repo-attached-meta">
                  <span class="mp-repo-attached-badge">${repo.private ? 'Private' : 'Public'}</span>
                  ${safeLang ? `<span>${safeLang}</span>` : ''}
                </span>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M7 17L17 7M7 7h10v10"/></svg>
            </a>
            <p class="mp-repo-attached-note">This listing is backed by a verified GitHub repository the seller connected.</p>
          </div>`;
      }

            function mpOpenModal(listing) {
              _currentListing = listing;
              // Keep the address bar in sync no matter which card/button
              // triggered this — clicking any listing anywhere in the app
              // funnels through here.
              if (listing?.id) window.__srfSetSectionPath?.(`/listing/${encodeURIComponent(listing.id)}`);

              // Detail-view beacon — fires once per open, distinct from the
              // card-impression counter (_mpObserveImpression). This is the
              // "actually opened it" signal in the seller funnel.
              _mpTrackListing('listing.view', listing?.id);

              // Dynamic per-listing SEO — title, description, OG/Twitter image,
              // canonical URL, and Product structured data, all built from
              // this listing's real data and the page's actual origin.
              if (typeof window.__seo?.applyListing === 'function') window.__seo.applyListing(listing);
            
              const title     = listing.title || 'Untitled';
              const desc      = listing.description || 'No description provided.';
              const type      = listing.type || 'website';
              const isTemplate = listing.isTemplate || false;
              const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
              const tc = type==='website'?'#60a5fa':type==='app'?'#a78bfa':type==='game'?'#f59e0b':'#34d399';
              const fin       = listing.financials || {};
              const tech      = listing.tech || {};
              const settings  = listing.settings || {};
              const platforms = listing.platforms || {};
              const transferMethods = listing.transferMethods || [];
              const price     = fin.price;
              const priceStr  = typeof price === 'number' ? `$${price.toLocaleString()}` : '—';
              const revenue   = fin.revenue  !== undefined ? `$${Number(fin.revenue).toLocaleString()}`  : '—';
              const expenses  = fin.expenses !== undefined ? `$${Number(fin.expenses).toLocaleString()}` : '—';
              const profit    = fin.profit   !== undefined ? `$${Number(fin.profit).toLocaleString()}`   : '—';
              const profitNum = fin.profit   !== undefined ? Number(fin.profit) : null;
            
              // ── Cover image ──
              const cover = listing.images?.[2] || listing.imageCover || listing.images?.[0] || 'https://placehold.co/800x450/1a1a1a/555555?text=No+Image';
            
              // ── Description with read-more ──
              const WORD_LIMIT = (window.__limits?.listing?.descPreviewWords) || 50;
              const descWords = desc.trim().split(/\s+/);
              const descNeedsReadMore = descWords.length > WORD_LIMIT;
              const descShort = descNeedsReadMore ? descWords.slice(0, WORD_LIMIT).join(' ') + '…' : desc;
              const descHtml = descNeedsReadMore
                ? `<p class="modal-desc" id="mpModalDesc">${descShort}</p><button class="mp-read-more-btn" id="mpReadMoreBtn" data-expanded="false">Read more</button>`
                : `<p class="modal-desc">${desc}</p>`;
            
              // ── Financials block (shared) ──
              const finHtml = `
                <div class="modal-section">
                  <div class="modal-section-title with-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${tc}" stroke-width="2.2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                    Financials
                  </div>
                  <div class="modal-financials">
                    <div class="fin-card"><span class="fin-label">Asking Price</span><span class="fin-value">${priceStr}</span></div>
                    <div class="fin-card"><span class="fin-label">Monthly Revenue</span><span class="fin-value">${revenue}</span></div>
                    <div class="fin-card"><span class="fin-label">Monthly Expenses</span><span class="fin-value">${expenses}</span></div>
                    <div class="fin-card"><span class="fin-label">Monthly Profit</span><span class="fin-value${profitNum !== null && profitNum >= 0 ? ' profit' : profitNum !== null ? ' loss' : ''}">${profit}</span></div>
                    ${fin.model ? `<div class="fin-card full"><span class="fin-label">Revenue Model</span><span class="fin-value">${fin.model}</span></div>` : ''}
                    ${fin.subMonthly ? `<div class="fin-card"><span class="fin-label">Sub / Month</span><span class="fin-value">$${Number(fin.subMonthly).toLocaleString()}</span></div>` : ''}
                    ${fin.subAnnual  ? `<div class="fin-card"><span class="fin-label">Sub / Year</span><span class="fin-value">$${Number(fin.subAnnual).toLocaleString()}</span></div>` : ''}
                  </div>
                </div>`;
            
              // ── Seller block (shared) ──
              const sellerHtml = `
                <div class="modal-section">
                  <div class="modal-section-title with-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${tc}" stroke-width="2.2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    Seller
                  </div>
                  <div class="modal-seller-section" id="mpModalSellerRow">
                    <div class="seller-avatar" id="mpModalSellerAv">?</div>
                    <div class="seller-name-row">
                      <div class="seller-name" id="mpModalSellerName">Loading…</div>
                      <div class="seller-handle" id="mpModalSellerHandle"></div>
                      <div class="seller-stars-row" id="mpModalSellerStars">${mpStars(0,0)}</div>
                    </div>
                    <svg class="seller-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                  </div>
                  <div class="modal-reveals-section" id="mpModalRevealsSection">
                    <div class="modal-reveals-title-row">
                      <div class="modal-reveals-title">Seller Reveals</div>
                      <span class="modal-reveals-count" id="mpModalRevealsCount" style="display:none;"></span>
                    </div>
                    <div class="modal-reveals-list" id="mpModalRevealsList">
                      <div class="reveals-empty">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                        Loading…
                      </div>
                    </div>
                  </div>
                </div>`;
            
              // ─────────────────────────────────────────
              // ── TYPE-SPECIFIC BODY HTML ──
              // ─────────────────────────────────────────
              let typeSpecificHtml = '';
              let heroHtml = '';
              let headerViewBtn = false;
            
              if (type === 'website') {
                const url = listing.url || '';
                heroHtml = `
                  <div class="modal-hero srf-lightbox-trigger" data-src="${cover}">
                    <img src="${cover}" alt="${title}" class="modal-cover" onerror="this.src='https://placehold.co/800x450/1a1a1a/555555?text=Error'">
                    <div class="modal-hero-overlay">
                      <div class="modal-hero-top-row">
                        <span class="modal-type-badge" style="background:rgba(10,10,12,0.86);color:${tc};border:1px solid ${tc};box-shadow:0 2px 10px rgba(0,0,0,0.4);">${isTemplate ? 'Template' : 'Website'}</span>
                        <span class="modal-price-badge">${priceStr}</span>
                      </div>
                      <div class="modal-hero-bottom-row">
                        <div class="modal-hero-title-block">
                          <h2 class="modal-hero-title">${title}</h2>
                        </div>
                      </div>
                    </div>
                  </div>`;
                headerViewBtn = !!url;
                const techItems = [
                  tech.frontend     && { label:'Frontend',     value:tech.frontend },
                  tech.backend      && { label:'Backend',      value:tech.backend },
                  tech.database     && { label:'Database',     value:tech.database },
                  tech.monetization && { label:'Monetization', value:tech.monetization }
                ].filter(Boolean);
                const galleryShots = [listing.images?.[0], listing.images?.[1]].filter(Boolean);
                const landscape2 = listing.images?.[3] || '';
                const galleryHtml = (galleryShots.length || landscape2) ? `
                  <div class="modal-gallery">
                    ${galleryShots.map((s,i)=>`<div class="modal-gallery-shot portrait srf-lightbox-trigger" data-src="${s}"><img src="${s}" alt="screenshot ${i+1}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`).join('')}
                    ${landscape2 ? `<div class="modal-gallery-shot wide srf-lightbox-trigger" data-src="${landscape2}"><img src="${landscape2}" alt="screenshot 4" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : ''}
                  </div>` : '';
                typeSpecificHtml = `
                  ${galleryHtml}
                  <div class="modal-content">
                    <div class="modal-section">
                      ${descHtml}
                      ${url ? `<div class="modal-url-row">
                        <a href="${url}" target="_blank" rel="noopener" class="modal-url">${url}</a>
                        <button class="modal-view-btn" id="mpInlineViewSite">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 010 20M12 2a14.5 14.5 0 000 20M2 12h20" stroke-linecap="round"/></svg>
                          Preview
                        </button>
                      </div>` : ''}
                    </div>
                    ${techItems.length ? `<div class="modal-section">
                      <div class="modal-section-title with-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${tc}" stroke-width="2.2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        Tech Stack
                      </div>
                      <div class="modal-tech-grid">
                        ${techItems.map(t=>`<div class="tech-item"><span class="tech-label">${t.label}</span><span class="tech-value">${t.value}</span></div>`).join('')}
                      </div>
                    </div>` : ''}
                    ${finHtml}
                    <div class="modal-section">
                      <div class="modal-section-title with-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${tc}" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
                        Business Details
                      </div>
                      <div class="modal-settings-grid">
                        ${settings.category ? `<div class="setting-item"><span>Category</span><span>${settings.category}</span></div>` : ''}
                        ${settings.age      ? `<div class="setting-item"><span>Site Age</span><span>${settings.age}</span></div>` : ''}
                        ${settings.location ? `<div class="setting-item"><span>Location</span><span>${settings.location}</span></div>` : ''}
                        ${settings.structure? `<div class="setting-item"><span>Structure</span><span>${settings.structure}</span></div>` : ''}
                        ${settings.reason   ? `<div class="setting-item full-width"><span>Reason for selling</span><span>${settings.reason}</span></div>` : ''}
                      </div>
                    </div>
                    ${_buildAttachedRepoHtml(listing.attachedRepo, '#60a5fa')}
                    ${_buildTransferMethodsHtml(transferMethods, '#60a5fa')}
                    ${sellerHtml}
                  </div>`;
            
              } else if (type === 'app') {
                const appIcon    = listing.appIcon || '';
                const videoUrl   = listing.videoUrl || '';
                const selPlatforms = platforms.selected || [];
                const iosUrl     = platforms.iosUrl || '';
                const androidUrl = platforms.androidUrl || '';
                const webUrl     = platforms.webUrl || '';
                const previewUrl = platforms.previewUrl || listing.previewUrl || '';
                // Build files to offer for download: the legacy single
                // apkUrl/apkStorageUrl fields (kept for back-compat), plus
                // the newer additionalFiles array, plus — if this listing is
                // marked "Not Live" — the notLiveBuildFiles.global array,
                // since that's the only place a not-live app's build lives.
                // Each entry may carry EITHER a real `url` (ready to use
                // immediately) OR a `storagePath` (must be signed on click
                // via listing.file-url, since app binaries never get a
                // permanent public url — see storage.js TRANSFER_FILE_EXTS).
                const buildFiles = [];
                if (listing.apkUrl || listing.apkStorageUrl) {
                  buildFiles.push({
                    filename: listing.apkIpaFileName || listing.apkFileName || 'app-build.apk',
                    url: listing.apkStorageUrl ? null : listing.apkUrl,
                    storagePath: listing.apkStorageUrl || null,
                  });
                }
                if (Array.isArray(listing.additionalFiles)) {
                  for (const f of listing.additionalFiles) {
                    if (f && (f.url || f.storagePath)) buildFiles.push(f);
                  }
                }
                if (listing.notLive === true && Array.isArray(listing.notLiveBuildFiles?.global)) {
                  for (const f of listing.notLiveBuildFiles.global) {
                    if (f && (f.url || f.storagePath)) buildFiles.push(f);
                  }
                }
                // De-dupe by filename+storagePath/url in case the same file
                // ended up reachable through more than one of the sources above.
                const seenBuildKeys = new Set();
                const dedupedBuildFiles = buildFiles.filter(f => {
                  const key = f.filename + '|' + (f.url || f.storagePath || '');
                  if (seenBuildKeys.has(key)) return false;
                  seenBuildKeys.add(key);
                  return true;
                });
                // Real 16:9 banner uploaded via the app maker is the hero;
                // all 3 portrait screenshots go in the gallery strip below
                // (none are "used up" as the hero anymore).
                const shots = (listing.images || []).filter(Boolean);
                const heroShot = listing.imageCover || appIcon || cover;
                const galleryShots = shots;
                const shotsHtml = galleryShots.length ? `
                  <div class="modal-gallery">
                    ${galleryShots.map(s=>`<div class="modal-gallery-shot tall srf-lightbox-trigger" data-src="${s}"><img src="${s}" alt="screenshot" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`).join('')}
                  </div>` : '';
                // Platform store links
                const storeLinksHtml = selPlatforms.length ? `
                  <div class="modal-app-stores">
                    ${iosUrl     ? `<button onclick="mpShowAdThenAction('App Store', ()=>window.open('${iosUrl}','_blank'))" class="modal-store-btn ios"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg> App Store</button>` : ''}
                    ${androidUrl ? `<button onclick="mpShowAdThenAction('Play Store', ()=>window.open('${androidUrl}','_blank'))" class="modal-store-btn android"><svg width="15" height="15" viewBox="0 0 512 512"><path fill="#00d2ff" d="M47.7 21.4C40 29.6 36 41.2 36 55.9v400.2c0 14.7 4 26.3 11.7 34.5l1.9 1.9L273 268.1v-4.7L49.6 19.5l-1.9 1.9z"/><path fill="#00f076" d="M347.5 342.5l-74.9-74.9v-4.7l74.9-74.9 1.7 1L438 234.6c25.6 14.5 25.6 38.3 0 52.9l-89.8 44.9-.7.1z"/><path fill="#ff3a44" d="M349.2 341.5L273 265.3 47.7 490.6c8.3 8.7 22 9.8 37.4 1.1l264.1-150.2"/><path fill="#ffcf00" d="M349.2 189.1L85.1 38.9c-15.4-8.7-29.1-7.6-37.4 1.1L273 265.3l76.2-76.2z"/></svg> Play Store</button>` : ''}
                    ${webUrl     ? `<button onclick="mpShowAdThenAction('Web App', ()=>window.open('${webUrl}','_blank'))" class="modal-store-btn web"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 010 20M2 12h20" stroke-linecap="round"/></svg> Web App</button>` : ''}
                  </div>` : '';
            
                // Build file download block — one row per file, supporting
                // multiple additional files (not just a single APK/IPA).
                // Files with a real `url` link directly; files with only a
                // `storagePath` render a button that resolves a fresh signed
                // URL via listing.file-url at click time (see
                // window.__downloadListingBuildFile below), since a raw
                // storagePath is never directly fetchable.
                const apkHtml = dedupedBuildFiles.length ? `
                  <div class="modal-app-apk-list">
                    ${dedupedBuildFiles.map((f, i) => `
                    <div class="modal-app-apk-block">
                      <div class="modal-app-apk-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      </div>
                      <div class="modal-app-apk-info">
                        <span class="modal-app-apk-label">${listing.notLive === true ? 'Preview Build (Not Live Yet)' : 'Test Build Available'}</span>
                        <span class="modal-app-apk-name">${f.filename || 'app-build.apk'}</span>
                      </div>
                      ${f.url ? `
                      <a href="${f.url}" target="_blank" rel="noopener" download="${f.filename || 'app.apk'}" class="modal-app-apk-btn">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Download
                      </a>` : `
                      <button type="button" class="modal-app-apk-btn" onclick="window.__downloadListingBuildFile('${listing.id}', '${(f.storagePath||'').replace(/'/g,"\\'")}', this)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Download
                      </button>`}
                    </div>`).join('')}
                  </div>` : '';
            
                // Preview iframe panel (web demo)
                const previewPanelHtml = previewUrl ? `
                  <div class="modal-section modal-app-preview-section">
                    <div class="modal-app-preview-header">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                      <span>Live Preview</span>
                    </div>
                    <div class="modal-app-preview-wrap" id="mpAppPreviewWrap" style="display:none;">
                      <div class="modal-app-preview-spinner" id="mpAppPreviewSpinner">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" style="animation:mp-spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-opacity="0.2"/><path d="M12 2a10 10 0 0110 10" stroke-linecap="round"/></svg>
                      </div>
                      <iframe id="mpAppPreviewIframe" src="about:blank"
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                        style="width:100%; height:480px; border:none; border-radius:0 0 12px 12px; background:#fff; display:block;"
                        loading="lazy"></iframe>
                    </div>
                    <button class="modal-app-preview-btn" id="mpAppPreviewBtn">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                      Open Demo Preview
                    </button>
                  </div>` : '';
            
                const techItems = [
                  tech.frontend     && { label:'Frontend',     value:tech.frontend },
                  tech.backend      && { label:'Backend',      value:tech.backend },
                  tech.database     && { label:'Database',     value:tech.database },
                  tech.monetization && { label:'Monetization', value:tech.monetization }
                ].filter(Boolean);
                heroHtml = `
                  <div class="modal-hero srf-lightbox-trigger" data-src="${heroShot}">
                    <img src="${heroShot}" alt="${title}" class="modal-cover" onerror="this.src='https://placehold.co/800x450/1a1a1a/555555?text=No+Image'">
                    <div class="modal-hero-overlay">
                      <div class="modal-hero-top-row">
                        <span class="modal-type-badge" style="background:rgba(10,10,12,0.86);color:${tc};border:1px solid ${tc};box-shadow:0 2px 10px rgba(0,0,0,0.4);">App${isTemplate?' · Template':''}</span>
                        <span class="modal-price-badge">${priceStr}</span>
                      </div>
                      <div class="modal-hero-bottom-row">
                        ${appIcon ? `<img src="${appIcon}" alt="${title} icon" class="modal-hero-icon-badge">` : `<div class="modal-hero-icon-badge-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="4"/></svg></div>`}
                        <div class="modal-hero-title-block">
                          <h2 class="modal-hero-title">${title}</h2>
                          <div class="modal-hero-pills">
                            ${selPlatforms.map(p=>`<span class="modal-hero-pill">${p==='ios'?'iOS':p==='android'?'Android':p==='web'?'Web':p}</span>`).join('')}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>`;
                typeSpecificHtml = `
                  ${shotsHtml}
                  <div class="modal-content">
                    <div class="modal-section modal-app-desc-section">
                      <div class="modal-app-section-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="16" x2="12" y2="16"/></svg>
                        About this App
                      </div>
                      ${descHtml}
                      ${storeLinksHtml}
                      ${videoUrl ? `<a href="${videoUrl}" target="_blank" rel="noopener" class="modal-video-link"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Watch Demo Video</a>` : ''}
                    </div>
                    ${apkHtml}
                    ${previewPanelHtml}
                    ${techItems.length ? `<div class="modal-section">
                      <div class="modal-section-title with-icon modal-app-section-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        Tech Stack
                      </div>
                      <div class="modal-tech-grid">
                        ${techItems.map(t=>`<div class="tech-item"><span class="tech-label">${t.label}</span><span class="tech-value">${t.value}</span></div>`).join('')}
                      </div>
                    </div>` : ''}
                    ${finHtml}
                    <div class="modal-section">
                      <div class="modal-section-title with-icon modal-app-section-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
                        App Details
                      </div>
                      <div class="modal-settings-grid">
                        ${settings.category  ? `<div class="setting-item"><span>Category</span><span>${settings.category}</span></div>` : ''}
                        ${settings.age       ? `<div class="setting-item"><span>App Age</span><span>${settings.age}</span></div>` : ''}
                        ${settings.structure ? `<div class="setting-item"><span>Structure</span><span>${settings.structure}</span></div>` : ''}
                        ${settings.reason    ? `<div class="setting-item full-width"><span>Reason for selling</span><span>${settings.reason}</span></div>` : ''}
                      </div>
                    </div>
                    ${_buildAttachedRepoHtml(listing.attachedRepo, '#a78bfa')}
                    ${_buildTransferMethodsHtml(transferMethods, '#a78bfa')}
                    ${sellerHtml}
                  </div>`;
            
              } else if (type === 'game') {
                const url       = listing.url || '';
                const gameType  = listing.gameType || 'link';
                // game stores platform under tech.frontend, genre under tech.backend
                const platform  = tech.frontend || '';
                const genre     = tech.backend  || '';
                const shots = (listing.images || []).filter(Boolean);
                // images[2] (landscape) becomes the big hero cover, matching
                // website/app; images[0]/[1] (portraits) go in the shared
                // gallery strip below, same component the other types use.
                const portrait0 = listing.images?.[0] || '';
                const portrait1 = listing.images?.[1] || '';
                const landscape  = listing.images?.[2] || '';
                const heroShot = landscape || portrait0 || portrait1 || cover;
                const galleryShots = [portrait0, portrait1].filter(Boolean);
                const shotsHtml = galleryShots.length ? `
                  <div class="modal-gallery">
                    ${galleryShots.map((s,i)=>`<div class="modal-gallery-shot portrait srf-lightbox-trigger" data-src="${s}"><img src="${s}" alt="screenshot ${i+1}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`).join('')}
                  </div>` : '';
            
                // Launch button → fullscreen modal with ad countdown
                const canPlay = !!url;
                const playPanelHtml = canPlay ? `
                  <div class="modal-section modal-game-play-section" id="mpGamePlaySection">
                    <button class="modal-game-play-btn" id="mpGamePlayBtn" style="width:100%;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      Launch Game
                    </button>
                  </div>` : '';
            
                heroHtml = `
                  <div class="modal-hero srf-lightbox-trigger" data-src="${heroShot}">
                    <img src="${heroShot}" alt="${title}" class="modal-cover" onerror="this.src='https://placehold.co/800x450/1a1a1a/555555?text=No+Image'">
                    <div class="modal-hero-overlay">
                      <div class="modal-hero-top-row">
                        <span class="modal-type-badge" style="background:rgba(10,10,12,0.86);color:${tc};border:1px solid ${tc};box-shadow:0 2px 10px rgba(0,0,0,0.4);">Game${isTemplate?' · Template':''}</span>
                        <span class="modal-price-badge">${priceStr}</span>
                      </div>
                      <div class="modal-hero-bottom-row">
                        <div class="modal-hero-title-block">
                          <h2 class="modal-hero-title">${title}</h2>
                          <div class="modal-hero-pills">
                            ${platform ? `<span class="modal-hero-pill">${platform}</span>` : ''}
                            ${genre    ? `<span class="modal-hero-pill">${genre}</span>` : ''}
                            ${gameType === 'upload' ? `<span class="modal-hero-pill">Playable in Browser</span>` : ''}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>`;
                typeSpecificHtml = `
                  ${shotsHtml}
                  <div class="modal-content">
                    <div class="modal-section modal-game-title-section">
                      ${descHtml}
                      ${url && gameType !== 'upload' ? `<button onclick="mpShowAdThenAction('View Game', ()=>window.open('${url}','_blank'))" class="modal-game-ext-link" style="background:none;border:none;cursor:pointer;font-family:inherit;padding:0;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#f59e0b;font-weight:600;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> View Game</button>` : ''}
                    </div>
                    ${playPanelHtml}
                    <div class="modal-section">
                      <div class="modal-section-title with-icon modal-game-section-title">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                        Game Details
                      </div>
                      <div class="modal-settings-grid">
                        ${platform ? `<div class="setting-item"><span>Platform</span><span>${platform}</span></div>` : ''}
                        ${genre    ? `<div class="setting-item"><span>Genre</span><span>${genre}</span></div>` : ''}
                        ${settings.age      ? `<div class="setting-item"><span>Game Age</span><span>${settings.age}</span></div>` : ''}
                        ${settings.structure? `<div class="setting-item"><span>Structure</span><span>${settings.structure}</span></div>` : ''}
                        ${gameType ? `<div class="setting-item"><span>Delivery</span><span>${gameType === 'upload' ? 'Browser Build' : 'External Link'}</span></div>` : ''}
                        ${settings.reason   ? `<div class="setting-item full-width"><span>Reason for selling</span><span>${settings.reason}</span></div>` : ''}
                      </div>
                    </div>
                    ${finHtml}
                    ${_buildAttachedRepoHtml(listing.attachedRepo, '#f59e0b')}
                    ${_buildTransferMethodsHtml(transferMethods, '#f59e0b')}
                    ${sellerHtml}
                  </div>`;
              }
            
              // ── Update header ──
              const headerTitle = document.getElementById('mpModalHeaderTitle');
              const viewSiteBtn = document.getElementById('mpModalViewSiteBtn');
              // Title is already shown as h2 inside the modal body — don't repeat it in the header
              if (headerTitle) { headerTitle.textContent = ''; headerTitle.style.display = 'none'; }
              if (viewSiteBtn) {
                viewSiteBtn.style.display = (type === 'website' && listing.url) ? 'flex' : 'none';
                viewSiteBtn.innerHTML = type === 'website'
                  ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 010 20M2 12h20" stroke-linecap="round"/></svg> Preview`
                  : '';
              }
              const ctaBar = document.getElementById('mpModalCtaBar');
              if (ctaBar) {
                ctaBar.style.display = 'flex';
                ctaBar.classList.remove('cta-visible');
                // Small delay so the animation fires fresh each open
                requestAnimationFrame(() => requestAnimationFrame(() => ctaBar.classList.add('cta-visible')));
              }
            
              mpModalBody.innerHTML = heroHtml + typeSpecificHtml;
              mpModal.classList.add('active');
              window.__srfLockScroll();
              // Every open must start scrolled to the top — this modal is
              // reused across listings, and without an explicit reset the
              // browser keeps whatever scrollTop the previous listing left
              // behind, so a new listing can open mid-scroll.
              mpModalBody.scrollTop = 0;
            
              // Wire read-more
              const readMoreBtn = document.getElementById('mpReadMoreBtn');
              if (readMoreBtn && descNeedsReadMore) {
                readMoreBtn.addEventListener('click', () => {
                  const expanded = readMoreBtn.dataset.expanded === 'true';
                  const descEl = document.getElementById('mpModalDesc');
                  if (expanded) {
                    descEl.textContent = descShort;
                    readMoreBtn.textContent = 'Read more';
                    readMoreBtn.dataset.expanded = 'false';
                  } else {
                    descEl.textContent = desc;
                    readMoreBtn.textContent = 'Show less';
                    readMoreBtn.dataset.expanded = 'true';
                  }
                });
              }
            
              // Wire Preview button (website only) — through ad overlay
              const inlineBtn = document.getElementById('mpInlineViewSite');
              if (inlineBtn && listing.url) inlineBtn.addEventListener('click', () => mpShowAdThenAction('Preview: ' + (listing.title||'Site'), () => mpOpenPreview(listing.url)));
            
              // Wire Game Play button — shows ad countdown then full-screen game modal
              const gamePlayBtn = document.getElementById('mpGamePlayBtn');
              if (gamePlayBtn && listing.url) {
                let _gameBlobUrl = null;
                gamePlayBtn.addEventListener('click', async () => {
                  mpShowAdThenAction('Launching: ' + (listing.title||'Game'), async () => {
                    await mpOpenGameFullscreen(listing, _gameBlobUrl, (url) => { _gameBlobUrl = url; });
                  });
                });
              }

              async function mpOpenGameFullscreen(gameListing, cachedBlob, setCachedBlob) {
                const preview  = document.getElementById('mpSitePreview');
                const frame    = document.getElementById('mpSiteFrame');
                const spinner  = document.getElementById('mpPreviewSpinner');
                if (!preview || !frame) return;

                let gameTitleEl = document.getElementById('mpPreviewGameTitle');
                if (!gameTitleEl) {
                  gameTitleEl = document.createElement('span');
                  gameTitleEl.id = 'mpPreviewGameTitle';
                  gameTitleEl.style.cssText = 'font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                  const ctrlRow = preview.querySelector('.mp-preview-ctrl-row');
                  if (ctrlRow) ctrlRow.insertBefore(gameTitleEl, ctrlRow.firstChild);
                }
                gameTitleEl.textContent = gameListing.title || 'Game';

                if (spinner) spinner.classList.remove('hidden');
                frame.style.opacity = '0';
                frame.style.background = '#000';
                frame.onload = () => { if (spinner) spinner.classList.add('hidden'); frame.style.opacity = '1'; };

                if (gameListing.gameType === 'upload') {
                  try {
                    if (!cachedBlob) {
                      let html = null;
                      try { const res = await fetch(gameListing.url); html = await res.text(); } catch(_){}
                      if (html) { setCachedBlob('__srcdoc__'); frame.srcdoc = html; }
                      else       { frame.src = gameListing.url; }
                    } else if (cachedBlob !== '__srcdoc__') {
                      frame.src = cachedBlob;
                    }
                  } catch(err) {
                    frame.srcdoc = '<body style="background:#000;color:#f87171;font-family:sans-serif;padding:20px"><b>Could not load game.</b><br><small>'+err.message+'</small></body>';
                  }
                } else {
                  frame.src = gameListing.url;
                }
                preview.style.display = 'flex';
                preview.style.flexDirection = 'column';
              }
            
              // Wire App Preview button
              const appPreviewBtn = document.getElementById('mpAppPreviewBtn');
              if (appPreviewBtn) {
                const _appPreviewUrl = listing.platforms?.previewUrl || listing.previewUrl || '';
                if (_appPreviewUrl) {
                  appPreviewBtn.addEventListener('click', () => {
                    const wrap    = document.getElementById('mpAppPreviewWrap');
                    const iframe  = document.getElementById('mpAppPreviewIframe');
                    const spinner = document.getElementById('mpAppPreviewSpinner');
                    if (!wrap || !iframe) return;
                    if (wrap.style.display === 'none' || !wrap.style.display) {
                      wrap.style.display = 'block';
                      spinner.style.display = 'flex';
                      iframe.style.opacity = '0';
                      appPreviewBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Close Preview`;
                      appPreviewBtn.classList.add('active');
                      iframe.onload = () => { spinner.style.display = 'none'; iframe.style.opacity = '1'; };
                      iframe.src = _appPreviewUrl;
                    } else {
                      wrap.style.display = 'none';
                      iframe.src = 'about:blank';
                      appPreviewBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> Open Demo Preview`;
                      appPreviewBtn.classList.remove('active');
                    }
                  });
                }
              }
            
              // Load real seller + wire View Seller btn + load reveals
              if (listing.ownerId) {
                mpGetSeller(listing.ownerId).then(seller => {
                  if (!seller) return;
                  const avEl    = document.getElementById('mpModalSellerAv');
                  const nameEl  = document.getElementById('mpModalSellerName');
                  const hndEl   = document.getElementById('mpModalSellerHandle');
                  const starsEl = document.getElementById('mpModalSellerStars');
                  if (nameEl) nameEl.innerHTML = '<span class="seller-name-text">' + srEscapeHtml(seller.username) + '</span>' + sellerBadgesHtml(seller);
                  if (hndEl)  hndEl.textContent  = '@' + seller.username.toLowerCase().replace(/\s+/g,'_');
                  if (avEl) {
                    if (seller.profilePic) {
                      avEl.innerHTML = `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`;
                    } else {
                      avEl.textContent = seller.username.charAt(0).toUpperCase();
                    }
                  }
                  // Real seller rating — renders as 5 SVG stars + (count).
                  // mpStars() already falls back to an all-empty 5-star row
                  // when rating/count are 0, so no separate placeholder is needed.
                  if (starsEl) starsEl.innerHTML = mpStars(seller.rating || 0, seller.ratingCount || 0);
                });

                // Whole seller row is clickable too, not just the button below it
                const sellerRow = document.getElementById('mpModalSellerRow');
                if (sellerRow) {
                  sellerRow.onclick = () => mpOpenSellerModal(listing.ownerId, listing);
                }

                // Load seller reviews (star ratings left by other users) —
                // these are seller-wide, not scoped to this one listing
                // (reviews live at users/{sellerUid}/reviews/{reviewerUid},
                // written by the "Rate this seller" overlay on the seller
                // profile page) — shown in a fixed-height scrollable list so
                // a long history doesn't push the rest of the modal down.
                (async () => {
                  const listEl = document.getElementById('mpModalRevealsList');
                  const countEl = document.getElementById('mpModalRevealsCount');
                  if (!listEl) return;
                  try {
                    const { collection, query, orderBy, limit, getDocs } =
                      await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                    const db = window.__db;
                    const q = query(
                      collection(db, 'users', listing.ownerId, 'reviews'),
                      orderBy('updatedAt', 'desc'),
                      limit(20)
                    );
                    const snap = await getDocs(q);
                    if (snap.empty) {
                      listEl.innerHTML = `<div class="reveals-empty">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                        No reviews yet</div>`;
                      if (countEl) countEl.style.display = 'none';
                      return;
                    }
                    if (countEl) {
                      countEl.textContent = snap.size;
                      countEl.style.display = 'inline-block';
                    }
                    const starSvg = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
                    const rows = snap.docs.map(d => {
                      const rev = d.data();
                      const reviewerName = rev.reviewerName || 'Someone';
                      const reviewerPic  = rev.reviewerPic  || '';
                      const stars = Math.max(0, Math.min(5, Math.round(rev.stars || 0)));
                      // Format timestamp
                      let timeStr = '';
                      if (rev.updatedAt) {
                        const ts = rev.updatedAt.toDate ? rev.updatedAt.toDate() : new Date(rev.updatedAt);
                        const diff = Math.floor((Date.now() - ts.getTime()) / 1000);
                        if (diff < 60)        timeStr = 'Just now';
                        else if (diff < 3600) timeStr = Math.floor(diff/60) + 'm ago';
                        else if (diff < 86400) timeStr = Math.floor(diff/3600) + 'h ago';
                        else if (diff < 604800) timeStr = Math.floor(diff/86400) + 'd ago';
                        else timeStr = ts.toLocaleDateString(undefined, { month:'short', day:'numeric' });
                      }
                      const initials = reviewerName.slice(0,2).toUpperCase();
                      const avHtml = reviewerPic
                        ? `<img src="${srEscapeHtml(reviewerPic)}" alt="${srEscapeHtml(reviewerName)}" onerror="this.parentElement.textContent='${srEscapeHtml(initials)}'">`
                        : srEscapeHtml(initials);
                      const reviewText = rev.review || '';
                      const starsHtml = Array.from({length:5}, (_,i) =>
                        `<span class="reveal-star${i < stars ? ' filled' : ''}">${starSvg}</span>`
                      ).join('');
                      return `<div class="reveal-row">
                        <div class="reveal-av">${avHtml}</div>
                        <div class="reveal-body">
                          <div class="reveal-meta">
                            <span class="reveal-name">${srEscapeHtml(reviewerName)}</span>
                            <span class="reveal-time">${timeStr}</span>
                          </div>
                          <div class="reveal-stars">${starsHtml}</div>
                          ${reviewText ? `<div class="reveal-msg">${srEscapeHtml(reviewText)}</div>` : ''}
                        </div>
                      </div>`;
                    });
                    listEl.innerHTML = rows.join('');
                  } catch(err) {
                    // Previously this swallowed `err` entirely and showed a
                    // generic "Could not load" that reads almost identically
                    // to the legit "No reviews yet" empty state — so a real
                    // failure (e.g. a missing Firestore index for the
                    // orderBy query above) looked like Firebase just
                    // returning nothing. Log it and surface it visibly.
                    console.error('[reveals] failed to load reviews for seller', listing.ownerId, err);
                    const listEl2 = document.getElementById('mpModalRevealsList');
                    if (listEl2) {
                      listEl2.innerHTML = '';
                      const msg = err?.message || 'Could not load';
                      if (msg.length > 60 || /https?:\/\//.test(msg)) {
                        window.__srfErrorBox(listEl2, msg, { title: 'Could not load reviews' });
                      } else {
                        listEl2.innerHTML = `<div class="reveals-empty">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                          ${srEscapeHtml(msg)}</div>`;
                      }
                    }
                  }
                })();
              }
            }
            // Exposed globally — this script runs as a module, so top-level
            // functions aren't attached to window automatically. Other script
            // blocks (e.g. the deal-chat "View Listing" button handler) need
            // to call this directly.
            window.mpOpenModal = mpOpenModal;
            
            function mpCloseModal() {
              mpModal.classList.remove('active');
              // Close any stacked overlays (Report / Share) that were opened
              // on top of this modal — otherwise they're left open with no
              // way to close them, and body scroll can stay locked forever.
              if (typeof window.__closeReportListing === 'function') window.__closeReportListing();
              if (typeof window.__closeShareModal === 'function') window.__closeShareModal();
              window.__srfUnlockScroll();
              _currentListing = null;
              // Defensive reset (in addition to the reset on open) so scroll
              // position never leaks between listings that share this modal.
              if (mpModalBody) mpModalBody.scrollTop = 0;
              // Restore homepage SEO defaults now that no listing is being viewed
              if (typeof window.__seo?.clearListing === 'function') window.__seo.clearListing();
              // Reset floating CTA so it re-animates on next open
              const ctaBar = document.getElementById('mpModalCtaBar');
              if (ctaBar) ctaBar.classList.remove('cta-visible');
              // Close fullscreen game/preview if open
              mpClosePreview();
              // Tear down any inline iframes
              const aIframe = document.getElementById('mpAppPreviewIframe');
              if (aIframe) { aIframe.src = 'about:blank'; }
              // Clear game title label
              const gTitle = document.getElementById('mpPreviewGameTitle');
              if (gTitle) gTitle.textContent = '';
            }
            window.mpCloseModal = mpCloseModal;
            
            /* ═══════════════════════════════════════════════════════
               SELLER PROFILE MODAL
            ═══════════════════════════════════════════════════════ */
            function mpCloseSellerModal() {
              const modal = document.getElementById('spModal');
              if (modal) modal.classList.remove('active');
              window.__srfUnlockScroll();
              if (typeof window.__seo?.clearListing === 'function') window.__seo.clearListing();
            }
            
            let _spCurrentSeller = null;
            let _spActiveType = 'all';
            
            const SP_LISTING_TYPE_META = {
              all:     { label: 'listings', empty: 'No active listings', emptyText: 'This seller has not listed anything for sale yet.' },
              website: { label: 'websites', empty: 'No websites listed', emptyText: 'This seller has not added any websites for sale.' },
              game:    { label: 'games',    empty: 'No games listed',    emptyText: 'This seller has not added any games for sale.' },
              app:     { label: 'apps',     empty: 'No apps listed',     emptyText: 'This seller has not added any apps for sale.' }
            };
            
            function spRenderListingsGrid() {
              const grid  = document.getElementById('spModalListingsGrid');
              const empty = document.getElementById('spModalEmpty');
              const badge = document.getElementById('spListingsBadgeCount');
              grid.innerHTML = '';
              const all = (_spCurrentSeller && _spCurrentSeller.listings) || [];
              const filtered = _spActiveType === 'all' ? all : all.filter(l => (l.type || 'website') === _spActiveType);
              const meta = SP_LISTING_TYPE_META[_spActiveType] || SP_LISTING_TYPE_META.all;
              badge.textContent = String(filtered.length);
            
              if (filtered.length === 0) {
                empty.style.display = '';
                document.getElementById('spModalEmptyTitle').textContent = meta.empty;
                document.getElementById('spModalEmptyText').textContent  = meta.emptyText;
                return;
              }
              empty.style.display = 'none';
            
              filtered.forEach(l => {
                const tc = l.type === 'app' ? '#a78bfa' : l.type === 'game' ? '#f59e0b' : '#60a5fa';
                const thumb = l.images?.[2] || l.imageCover || l.images?.[0]
                  || 'https://placehold.co/400x225/111/444?text=Listing';
                const priceTxt = typeof l.financials?.price === 'number'
                  ? `$${l.financials.price.toLocaleString()}` : 'Make offer';
                const card = document.createElement('div');
                card.className = 'sp-listing-card';
                card.innerHTML = `
                  <div class="sp-listing-thumb"><img src="${thumb}" loading="lazy" alt="${l.title || ''}" onerror="this.src='https://placehold.co/400x225/111/444?text=Listing'"></div>
                  <div class="sp-listing-info">
                    <div class="sp-listing-type" style="color:${tc};">${(l.type||'website').toUpperCase()}</div>
                    <div class="sp-listing-title">${l.title || 'Untitled'}</div>
                    <div class="sp-listing-price">${priceTxt}</div>
                  </div>`;
                card.addEventListener('click', () => { mpCloseSellerModal(); mpOpenModal(l); });
                grid.appendChild(card);
              });
            }
            
            document.querySelectorAll('#spModalListingsHeader .sp-toggle-tab').forEach(tab => {
              tab.addEventListener('click', () => {
                document.querySelectorAll('#spModalListingsHeader .sp-toggle-tab').forEach(t => {
                  t.classList.remove('active');
                  t.setAttribute('aria-selected', 'false');
                });
                tab.classList.add('active');
                tab.setAttribute('aria-selected', 'true');
                _spActiveType = tab.dataset.type;
                spRenderListingsGrid();
              });
            });
            
            async function mpOpenSellerModal(uid, fromListing) {
              const modal  = document.getElementById('spModal');
              const inner  = document.getElementById('spModalInner');
              if (!modal) return;
              // Keep the address bar in sync no matter which row/card/button
              // triggered this.
              if (uid) window.__srfSetSectionPath?.(`/seller/${encodeURIComponent(uid)}`);

              // Profile-view beacon — fire-and-forget, matches deal.js's
              // record-profile-view action.
              if (uid) {
                fetch('/api/deal', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'record-profile-view', sellerUid: uid }),
                }).catch(err => console.error('[mpOpenSellerModal] profile view beacon', err.message));
              }

              // Reset state
              _spCurrentSeller = null;
              _spActiveType = 'all';
              document.querySelectorAll('#spModalListingsHeader .sp-toggle-tab').forEach(t => {
                t.classList.toggle('active', t.dataset.type === 'all');
                t.setAttribute('aria-selected', t.dataset.type === 'all' ? 'true' : 'false');
              });
              document.getElementById('spModalAv').innerHTML   = '?';
              document.getElementById('spModalName').textContent  = 'Loading…';
              document.getElementById('spModalHandle').textContent = '';
              document.getElementById('spModalBio').style.display = 'none';
              document.getElementById('spModalBioText').textContent = '';
              document.getElementById('spModalBioText').style.color = '';
              document.getElementById('spModalBioMore').style.display = 'none';
              // Cover banner — no user-uploaded banners exist yet, so always use a
              // stable placeholder image (seeded per-seller so it doesn't change on re-open)
              document.getElementById('spModalCover').innerHTML =
                `<img src="https://picsum.photos/seed/${encodeURIComponent(uid || 'seller')}/800/240" alt="" loading="lazy">`;
              document.getElementById('spModalStarsIcons').innerHTML = '';
              document.getElementById('spModalStarCount').textContent = '';
              document.getElementById('spModalStars').style.display = 'none';
              document.getElementById('spModalSocials').innerHTML = '';
              document.getElementById('spStatListings').textContent = '—';
              document.getElementById('spStatRating').textContent   = '—';
              document.getElementById('spStatJoined').textContent   = '—';
              document.getElementById('spModalListingsGrid').innerHTML = '';
              document.getElementById('spModalEmpty').style.display = 'none';
              document.getElementById('spModalPrivate').style.display = 'none';
              document.getElementById('spModalListingsSkelGrid').style.display = '';
              const _listingsHeaderReset = document.getElementById('spModalListingsHeader');
              if (_listingsHeaderReset) _listingsHeaderReset.style.display = '';
              document.getElementById('spListingsBadgeCount').textContent = '0';
              document.getElementById('spModalListingsSection').style.display = '';
              // Reset action buttons
              const _fBtn = document.getElementById('spFollowBtn');
              const _rBtn = document.getElementById('spRateBtn');
              const _repBtn = document.getElementById('spReportSellerBtn');
              if (_fBtn) { _fBtn.classList.remove('sp-follow-active'); _fBtn.dataset.uid = ''; _fBtn.dataset.following = ''; _fBtn.style.display = ''; }
              if (_rBtn) { _rBtn.dataset.uid = ''; _rBtn.style.display = ''; }
              if (_repBtn) { _repBtn.style.display = ''; _repBtn.onclick = null; }
              document.getElementById('spFollowerCount').textContent = '—';
              document.getElementById('spStatFollowers').textContent = '—';
              inner.scrollTop = 0;
            
              modal.classList.add('active');
              modal.classList.add('sp-loading'); // shows skeleton placeholders until data resolves below
              window.__srfLockScroll();
            
              if (!uid) {
                modal.classList.remove('sp-loading');
                document.getElementById('spModalName').textContent = 'Unknown Seller';
                return;
              }
            
              // Invalidate cache so we always get fresh full data (including listings)
              delete _sellerCache[uid];
              const seller = await mpGetSeller(uid);
              if (!seller) {
                modal.classList.remove('sp-loading');
                document.getElementById('spModalName').textContent = 'Seller not found';
                return;
              }

              // Public, non-private profile — safe to expose in page meta.
              if (seller.profileVisibility !== 'private' && typeof window.__seo?.applySeller === 'function') {
                window.__seo.applySeller(uid, { displayName: seller.username, profilePic: seller.profilePic });
              }

              // ── Privacy gate ──────────────────────────────────────────
              const _meUid = window.__auth?.currentUser?.uid;
              const _isOwnProfile = _meUid && _meUid === uid;
              if (!_isOwnProfile) {
                if (seller.profileVisibility === 'private') {
                  modal.classList.remove('sp-loading');
                  document.getElementById('spModalName').textContent = seller.username;
                  document.getElementById('spModalHandle').textContent = '@' + seller.username.toLowerCase().replace(/\s+/g,'_');
                  const bioEl = document.getElementById('spModalBio');
                  const bioTextEl = document.getElementById('spModalBioText');
                  bioTextEl.textContent = 'This profile is private.';
                  bioTextEl.style.color = '#555';
                  bioEl.style.display = '';
                  document.getElementById('spModalBioMore').style.display = 'none';
                  document.getElementById('spModalSocials').innerHTML = '';
                  document.getElementById('spFollowBtn').style.display = 'none';
                  document.getElementById('spRateBtn').style.display = 'none';
                  // Keep the listings section visible, but swap the grid for a
                  // private-state message + buyer caution tip instead of
                  // leaving the area blank.
                  document.getElementById('spModalListingsGrid').innerHTML = '';
                  document.getElementById('spModalListingsSkelGrid').style.display = 'none';
                  document.getElementById('spModalEmpty').style.display = 'none';
                  document.getElementById('spModalPrivate').style.display = '';
                  const _listingsHeader = document.getElementById('spModalListingsHeader');
                  if (_listingsHeader) _listingsHeader.style.display = 'none';
                  return;
                }
                if (seller.profileVisibility === 'members' && !_meUid) {
                  modal.classList.remove('sp-loading');
                  document.getElementById('spModalName').textContent = seller.username;
                  const bioEl = document.getElementById('spModalBio');
                  const bioTextEl = document.getElementById('spModalBioText');
                  bioTextEl.textContent = 'Sign in to view this profile.';
                  bioTextEl.style.color = '#555';
                  bioEl.style.display = '';
                  document.getElementById('spModalBioMore').style.display = 'none';
                  document.getElementById('spModalListingsSection').style.display = 'none';
                  document.getElementById('spModalSocials').innerHTML = '';
                  document.getElementById('spFollowBtn').style.display = 'none';
                  document.getElementById('spRateBtn').style.display = 'none';
                  return;
                }
              }
              // ─────────────────────────────────────────────────────────
            
              _spCurrentSeller = seller;
            
              // Avatar
              const avEl = document.getElementById('spModalAv');
              if (seller.profilePic) {
                avEl.innerHTML = `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`;
              } else {
                avEl.textContent = seller.username.charAt(0).toUpperCase();
              }
            
              document.getElementById('spModalName').innerHTML  = srEscapeHtml(seller.username) + ' ' + sellerBadgesHtml(seller);
              document.getElementById('spModalHandle').textContent = `@${seller.username.toLowerCase().replace(/\s+/g,'_')}`;
              {
                const bioEl     = document.getElementById('spModalBio');
                const bioTextEl = document.getElementById('spModalBioText');
                const moreBtn   = document.getElementById('spModalBioMore');
                const hasBio    = seller.bio && (seller.showBio || _isOwnProfile);
                if (hasBio) {
                  bioTextEl.textContent = seller.bio;
                  bioTextEl.style.color = '';
                  // Only show "Read more" if the bio actually overflows the 3-line clamp
                  requestAnimationFrame(() => {
                    const overflowing = bioTextEl.scrollHeight > bioTextEl.clientHeight + 1;
                    moreBtn.style.display = overflowing ? '' : 'none';
                  });
                } else {
                  // Hardcoded placeholder — always shown when the seller has no
                  // bio (or has hidden it), so the bio row never just disappears.
                  bioTextEl.textContent = SP_NO_BIO_PLACEHOLDER;
                  bioTextEl.style.color = '#555';
                  // Still let people open the popup for socials / contact / stats
                  moreBtn.style.display = '';
                }
                // Unconditional safety net: no matter which branch ran above
                // (or if some future edit adds a new branch and forgets to set
                // this), the bio row itself must always be visible under the
                // stat cards rather than silently collapsing to nothing.
                bioEl.style.display = '';
                moreBtn.onclick = () => spOpenDetailsOverlay(seller);
              }
            
              // Stars
              if (seller.ratingCount > 0) {
                document.getElementById('spModalStars').style.display = '';
                document.getElementById('spModalStarsIcons').innerHTML = mpStars(seller.rating, seller.ratingCount);
                document.getElementById('spModalStarCount').textContent = seller.rating.toFixed(1);
              }
            
              // Stats
              document.getElementById('spStatListings').textContent = seller.listings?.length ?? '—';
              document.getElementById('spStatRating').textContent   = seller.ratingCount > 0 ? seller.rating.toFixed(1) : '—';
              document.getElementById('spStatFollowers').textContent = seller.followerCount > 999
                ? (seller.followerCount / 1000).toFixed(1) + 'k'
                : String(seller.followerCount);
              document.getElementById('spFollowerCount').textContent = seller.followerCount > 999
                ? (seller.followerCount / 1000).toFixed(1) + 'k'
                : String(seller.followerCount);
              if (seller.joinedAt) {
                const mo = seller.joinedAt.toLocaleString('default', { month:'short' });
                document.getElementById('spStatJoined').textContent = mo + ' ' + seller.joinedAt.getFullYear();
              }

              // ── Wire Follow button ──
              const followBtn = document.getElementById('spFollowBtn');
              if (followBtn) {
                followBtn.dataset.uid = uid;
                const currentUser = window.__auth?.currentUser;
                // Can't follow yourself
                if (currentUser && currentUser.uid === uid) {
                  followBtn.style.display = 'none';
                } else {
                  followBtn.style.display = '';
                  // Check if already following
                  let _isFollowing = false;
                  if (currentUser) {
                    try {
                      const { doc: _fd, getDoc: _fg } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                      const fSnap = await _fg(_fd(window.__db, 'users', uid, 'followers', currentUser.uid));
                      _isFollowing = fSnap.exists();
                    } catch(_) {}
                  }
                  _updateFollowBtn(followBtn, _isFollowing, seller.followerCount);

                  followBtn.onclick = async () => {
                    const user = window.__auth?.currentUser;
                    if (!user) { document.querySelector('.btn-login')?.click(); return; }
                    try {
                      const { doc: _fd, setDoc: _fs, deleteDoc: _fdel, serverTimestamp: _fts, increment: _finc, updateDoc: _fupd } =
                        await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                      const isNowFollowing = followBtn.dataset.following === 'true';
                      const followerRef = _fd(window.__db, 'users', uid, 'followers', user.uid);
                      const followingRef = _fd(window.__db, 'users', user.uid, 'following', uid);
                      if (isNowFollowing) {
                        // Unfollow
                        await _fdel(followerRef);
                        await _fdel(followingRef);
                        seller.followerCount = Math.max(0, seller.followerCount - 1);
                      } else {
                        // Follow
                        const uData = window.__fbUserData || {};
                        const myName = uData.username || user.displayName || user.email?.split('@')[0] || 'Someone';
                        await _fs(followerRef, { uid: user.uid, username: myName, pic: uData.profilePic || '', followedAt: _fts() });
                        await _fs(followingRef, { uid, username: seller.username, pic: seller.profilePic || '', followedAt: _fts() });
                        seller.followerCount = seller.followerCount + 1;
                      }
                      const newState = !isNowFollowing;
                      _updateFollowBtn(followBtn, newState, seller.followerCount);
                      document.getElementById('spFollowerCount').textContent = seller.followerCount > 999
                        ? (seller.followerCount / 1000).toFixed(1) + 'k' : String(seller.followerCount);
                      document.getElementById('spStatFollowers').textContent = document.getElementById('spFollowerCount').textContent;
                    } catch(e) { console.error('Follow error:', e); }
                  };
                }
              }

              // ── Wire Rate button ──
              const rateBtn = document.getElementById('spRateBtn');
              if (rateBtn) {
                rateBtn.dataset.uid = uid;
                const meUid = window.__auth?.currentUser?.uid;
                // Can't rate yourself
                if (meUid && meUid === uid) {
                  rateBtn.style.display = 'none';
                } else {
                  rateBtn.style.display = '';
                  rateBtn.onclick = () => _openRateOverlay(uid, seller.username);
                }
              }

              // ── Wire Donate button ──
              const donateBtn = document.getElementById('spDonateBtn');
              if (donateBtn) {
                const meUid = window.__auth?.currentUser?.uid;
                // Can't donate to yourself
                if (meUid && meUid === uid) {
                  donateBtn.style.display = 'none';
                } else {
                  donateBtn.style.display = '';
                  donateBtn.onclick = () => spOpenDonateOverlay(seller);
                }
              }

              // ── Wire Report Seller button ──
              // Lets a buyer flag a seller straight from their profile, rather
              // than only from inside an active deal chat. Mirrors the
              // existing "Report User" deal-chat flow: write to the `reports`
              // collection, then hand off to the AI triage endpoint.
              const reportSellerBtn = document.getElementById('spReportSellerBtn');
              if (reportSellerBtn) {
                const meUid = window.__auth?.currentUser?.uid;
                // Can't report yourself
                if (meUid && meUid === uid) {
                  reportSellerBtn.style.display = 'none';
                } else {
                  reportSellerBtn.style.display = '';
                  reportSellerBtn.onclick = async () => {
                    const user = window.__auth?.currentUser;
                    if (!user) { document.querySelector('.btn-login')?.click(); return; }
                    const confirmed = await window.srfModal.confirm('', {
                      theme: 'report', icon: 'report', title: 'Report Seller',
                      msg: `Report ${seller.username}'s profile to our team? Our moderators will review it and take action if needed. False reports may result in account restrictions.`,
                      confirmText: 'Report'
                    });
                    if (!confirmed) return;
                    try {
                      const { addDoc, collection, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                      const reportRef = await addDoc(collection(window.__db, 'reports'), {
                        reporterUid:  user.uid,
                        reportedUid:  uid,
                        reason:       'seller_profile_report',
                        status:       'open',
                        createdAt:    serverTimestamp(),
                      });
                      window.__aiStudioCall('triage-report', {
                        reportId: reportRef.id,
                        evidence: {
                          reporterUid: user.uid,
                          reportedUid: uid,
                          reason: 'seller_profile_report',
                        },
                      }).catch(err => console.warn('AI triage call failed (report still filed, will need manual review):', err));
                    } catch (err) {
                      console.warn('seller report write', err);
                    }
                    await window.srfModal.alert('', { theme: 'report', icon: 'report', title: 'Report Submitted', msg: 'Our team will review this within 24 hours. Thank you for keeping Siterifty safe.' });
                  };
                }
              }
            
              // Social links — only show if seller's privacy allows it
              const socialsEl = document.getElementById('spModalSocials');
              if (!seller.showSocial && !_isOwnProfile) {
                socialsEl.innerHTML = '';
              } else {
              const socialDefs = [
                { key: 'website',  label: 'Website',  icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></svg>` },
                { key: 'twitter',  label: 'Twitter',  icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>` },
                { key: 'github',   label: 'GitHub',   icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>` },
                { key: 'linkedin', label: 'LinkedIn', icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>` },
              ];
              socialDefs.forEach(({ key, label, icon }) => {
                let val = seller[key];
                if (!val) return;
                if (!val.startsWith('http')) val = 'https://' + val;
                const a = document.createElement('a');
                a.className = 'sp-social-btn';
                a.href = val; a.target = '_blank'; a.rel = 'noopener';
                a.innerHTML = `${icon} ${label}`;
                socialsEl.appendChild(a);
              });
              } // end showSocial check
            
              // Listings grid (filtered by active toggle tab)
              spRenderListingsGrid();

              // Main profile render is done — drop the skeleton now. Deal
              // stats (lifetime/7-day revenue, category split) load
              // separately below since they need their own server round
              // trip; that section shows its own small skeleton in the
              // meantime rather than blocking the whole modal.
              modal.classList.remove('sp-loading');

              spLoadSellerStats(uid);
            }
            window.__openSellerProfile = mpOpenSellerModal;
            window.__closeSellerProfile = mpCloseSellerModal;
            // sellers-transfer.js (a non-module script, so it can't see
            // this module's local names) calls the global by this exact
            // name when a profile card in the sellers directory is
            // clicked. Without this alias that click silently no-ops.
            window.mpOpenSellerModal = mpOpenSellerModal;

            // Fetches lifetime/7-day deal stats for the seller-details popup
            // (see spOpenDetailsOverlay) from deal.js's get-seller-stats
            // action. Cached per-uid alongside the rest of seller data so
            // reopening "Read more" during the same modal session doesn't
            // refetch.
            async function spLoadSellerStats(uid) {
              const box = document.getElementById('spDetailsStats');
              if (!box) return;
              box.querySelectorAll('.sp-dstat').forEach(el => el.classList.add('sp-skel-stat2'));
              document.getElementById('spDetailsStatsEmpty').style.display = 'none';
              try {
                const resp = await fetch('/api/deal', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'get-seller-stats', sellerUid: uid }),
                });
                const out = await resp.json();
                if (!resp.ok || !out.ok) throw new Error(out.error || 'Could not load seller stats');
                if (_spCurrentSeller) _spCurrentSeller._dealStats = out;
                spRenderSellerStats(out);
              } catch (err) {
                console.error('[spLoadSellerStats] failed', err);
                spRenderSellerStats(null);
              }
            }

            function spRenderSellerStats(stats) {
              const box = document.getElementById('spDetailsStats');
              if (!box) return;
              box.querySelectorAll('.sp-dstat').forEach(el => el.classList.remove('sp-skel-stat2'));

              const fmtMoney = n => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
              const lifetimeDeals    = stats?.lifetimeDeals ?? 0;
              const lifetimeRevenue  = stats?.lifetimeRevenue ?? 0;
              const last7DaysRevenue = stats?.last7DaysRevenue ?? 0;
              const byCategory       = stats?.byCategory || { website: 0, app: 0, game: 0 };

              document.getElementById('spDetailsStatDeals').textContent   = String(lifetimeDeals);
              document.getElementById('spDetailsStatRevenue').textContent = fmtMoney(lifetimeRevenue);
              document.getElementById('spDetailsStat7d').textContent      = fmtMoney(last7DaysRevenue);

              const catTotal = byCategory.website + byCategory.app + byCategory.game;
              ['website','app','game'].forEach(cat => {
                const count = byCategory[cat] || 0;
                const pct = catTotal > 0 ? Math.round((count / catTotal) * 100) : 0;
                const bar = document.getElementById('spCatBar' + cat.charAt(0).toUpperCase() + cat.slice(1));
                const cnt = document.getElementById('spCatCount' + cat.charAt(0).toUpperCase() + cat.slice(1));
                if (bar) bar.style.width = pct + '%';
                if (cnt) cnt.textContent = String(count);
              });

              document.getElementById('spDetailsCatBreakdown').style.display = catTotal > 0 ? '' : 'none';
              document.getElementById('spDetailsStatsEmpty').style.display   = catTotal > 0 ? 'none' : '';
            }

            const SP_SOCIAL_DEFS = [
              { key: 'website',  label: 'Website',  icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></svg>` },
              { key: 'twitter',  label: 'Twitter',  icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>` },
              { key: 'github',   label: 'GitHub',   icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>` },
              { key: 'linkedin', label: 'LinkedIn', icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>` },
            ];

            function spOpenDetailsOverlay(seller) {
              const overlay = document.getElementById('spDetailsOverlay');
              if (!overlay || !seller) return;

              // Declared up top — previously this was used on the bio line
              // below before its own declaration further down the function,
              // which threw a ReferenceError (temporal dead zone) and broke
              // "Read more" every time it was clicked.
              const _meUid = window.__auth?.currentUser?.uid;
              const _isOwn = _meUid && _meUid === seller.uid;

              const avEl = document.getElementById('spDetailsAv');
              if (seller.profilePic) {
                avEl.innerHTML = `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`;
              } else {
                avEl.textContent = seller.username.charAt(0).toUpperCase();
              }
              document.getElementById('spDetailsName').innerHTML = srEscapeHtml(seller.username) + ' ' + sellerBadgesHtml(seller);
              document.getElementById('spDetailsHandle').textContent = `@${seller.username.toLowerCase().replace(/\s+/g,'_')}`;
              document.getElementById('spDetailsBio').textContent = (seller.bio && (seller.showBio || _isOwn)) ? seller.bio : 'This seller hasn\'t added a bio yet.';

              // Socials
              const socialsEl = document.getElementById('spDetailsSocials');
              socialsEl.innerHTML = '';
              if (seller.showSocial || _isOwn) {
                SP_SOCIAL_DEFS.forEach(({ key, label, icon }) => {
                  let val = seller[key];
                  if (!val) return;
                  if (!val.startsWith('http')) val = 'https://' + val;
                  const a = document.createElement('a');
                  a.className = 'sp-social-btn';
                  a.href = val; a.target = '_blank'; a.rel = 'noopener';
                  a.innerHTML = `${icon} ${label}`;
                  socialsEl.appendChild(a);
                });
              }

              // Contact email + CTA — only if seller has one and has chosen to show it
              const emailEl = document.getElementById('spDetailsEmail');
              const contactBtn = document.getElementById('spDetailsContactBtn');
              const canShowEmail = seller.contactEmail && (seller.showEmail || _isOwn);
              if (canShowEmail) {
                emailEl.textContent = seller.contactEmail;
                contactBtn.disabled = false;
                contactBtn.onclick = () => { window.location.href = `mailto:${seller.contactEmail}`; };
              } else {
                emailEl.textContent = 'No contact email shared';
                contactBtn.disabled = true;
                contactBtn.onclick = null;
              }

              // Deal stats — use whatever spLoadSellerStats already fetched
              // for this modal session; if it hasn't resolved yet (or
              // failed), fetch fresh right now rather than leaving the
              // skeleton spinning indefinitely.
              if (seller._dealStats) {
                spRenderSellerStats(seller._dealStats);
              } else {
                document.querySelectorAll('#spDetailsStats .sp-dstat').forEach(el => el.classList.add('sp-skel-stat2'));
                spLoadSellerStats(seller.uid);
              }

              overlay.classList.add('active');
            }
            function spCloseDetailsOverlay() {
              document.getElementById('spDetailsOverlay')?.classList.remove('active');
            }
            document.getElementById('spDetailsClose')?.addEventListener('click', spCloseDetailsOverlay);
            document.getElementById('spDetailsOverlay')?.addEventListener('click', e => {
              if (e.target.id === 'spDetailsOverlay') spCloseDetailsOverlay();
            });

            document.getElementById('spModalClose')?.addEventListener('click', () => {
              mpCloseSellerModal();
              if (location.pathname.replace(/\/+$/, '').startsWith('/seller/')) {
                window.__srfSetSectionPath?.('/marketplace');
              }
            });
            document.getElementById('spModal')?.addEventListener('click', e => {
              if (e.target === document.getElementById('spModal')) {
                mpCloseSellerModal();
                if (location.pathname.replace(/\/+$/, '').startsWith('/seller/')) {
                  window.__srfSetSectionPath?.('/marketplace');
                }
              }
            });

            /* ── Follow button state helper ── */
            function _updateFollowBtn(btn, isFollowing, count) {
              btn.dataset.following = String(isFollowing);
              if (isFollowing) {
                btn.classList.add('sp-follow-active');
                btn.innerHTML = `
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <polyline points="16 11 18 13 22 9"/>
                  </svg>
                  Following
                  <span id="spFollowerCount">${count > 999 ? (count/1000).toFixed(1)+'k' : count}</span>`;
              } else {
                btn.classList.remove('sp-follow-active');
                btn.innerHTML = `
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <line x1="19" y1="8" x2="19" y2="14"/>
                    <line x1="22" y1="11" x2="16" y2="11"/>
                  </svg>
                  Follow
                  <span id="spFollowerCount">${count > 999 ? (count/1000).toFixed(1)+'k' : count}</span>`;
              }
            }

            /* ═══════════════════════════════════════
               LEADERBOARD MODAL
               Ranks users by number of active listings (most listings = highest rank).
               Reuses mpGetSeller() / mpOpenSellerModal() so the row's profile,
               follow state, and listings grid all stay perfectly in sync with the
               rest of the app.
               ═══════════════════════════════════════ */
            const lbCrownSvg = `<svg class="lb-crown" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M3 17l1.5-9L9 12l3-7 3 7 4.5-4L21 17H3z" fill="#facc15" stroke="#b8860b" stroke-width="0.6" stroke-linejoin="round"/><rect x="3" y="17" width="18" height="2.4" rx="1" fill="#facc15" stroke="#b8860b" stroke-width="0.4"/></svg>`;

            function lbFollowIcon(following) {
              return following
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;
            }

            // Cache so re-opening the leaderboard in the same session feels instant;
            // a fresh open still re-fetches in the background and silently updates.
            let _lbCache = null;

            async function lbFetchTopSellers() {
              const { collection, query, getDocs, limit } =
                await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
              const db = await window.__dbReady;

              // Cheap random-ish pick: pull a small fixed page of users (5 reads)
              // and show all of them — no listings scan, no extra reads.
              const usnap = await getDocs(query(collection(db, 'users'), limit(5)));
              const uids = [];
              usnap.forEach(d => uids.push(d.id));

              // Hydrate via the shared seller cache/fetcher (cached, so repeat
              // opens in the same session cost nothing extra).
              const rows = await Promise.all(uids.map(async uid => {
                const seller = await mpGetSeller(uid);
                if (!seller) return null;
                return { uid, listingCount: 0, seller };
              }));
              return rows.filter(Boolean);
            }

            function lbRenderRows(rows) {
              const list  = document.getElementById('lbModalList');
              const empty = document.getElementById('lbModalEmpty');
              if (!list) return;
              if (!rows.length) {
                list.innerHTML = '';
                empty.style.display = '';
                return;
              }
              empty.style.display = 'none';
              const myUid = window.__auth?.currentUser?.uid;

              list.innerHTML = rows.map((row, i) => {
                const rank = i + 1;
                const { seller, listingCount, uid } = row;
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
                const avatarInner = seller.profilePic
                  ? `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`
                  : seller.username.charAt(0).toUpperCase();
                const joined = seller.joinedAt
                  ? seller.joinedAt.toLocaleString('default', { month: 'short', year: 'numeric' })
                  : null;
                const isSelf = myUid && myUid === uid;

                return `
                  <div class="lb-row ${rank <= 3 ? 'lb-top3' : ''} ${rank === 1 ? 'lb-rank1' : ''}" data-uid="${uid}">
                     <div class="lb-rank ${medal ? 'lb-rank-medal' : ''}">${medal || rank}</div>
                     <div class="lb-av-wrap">
                        ${rank === 1 ? lbCrownSvg : ''}
                        <div class="lb-av">${avatarInner}</div>
                     </div>
                     <div class="lb-info">
                        <div class="lb-name"><span class="lb-name-text">${srEscapeHtml(seller.username)}</span>${sellerBadgesHtml(seller)}</div>
                        <div class="lb-handle">@${seller.username.toLowerCase().replace(/\s+/g, '_')}</div>
                        <div class="lb-meta">
                           <span class="lb-meta-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg><span class="lb-listing-count">${listingCount}</span>&nbsp;listing${listingCount === 1 ? '' : 's'}</span>
                           ${joined ? `<span class="lb-meta-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>Joined ${joined}</span>` : ''}
                        </div>
                     </div>
                     ${isSelf ? '' : `<button class="lb-follow-btn" data-uid="${uid}" aria-label="Follow ${seller.username}"></button>`}
                  </div>`;
              }).join('');

              // Wire row click → full profile modal
              list.querySelectorAll('.lb-row').forEach(rowEl => {
                rowEl.addEventListener('click', (e) => {
                  if (e.target.closest('.lb-follow-btn')) return;
                  mpOpenSellerModal(rowEl.dataset.uid);
                });
              });

              // Wire each follow button independently
              list.querySelectorAll('.lb-follow-btn').forEach(btn => {
                lbWireFollowBtn(btn, rows.find(r => r.uid === btn.dataset.uid)?.seller);
              });
            }

            async function lbWireFollowBtn(btn, seller) {
              if (!btn || !seller) return;
              const uid = btn.dataset.uid;
              const currentUser = window.__auth?.currentUser;
              const setState = (following) => {
                btn.classList.toggle('lb-following', following);
                btn.innerHTML = `${lbFollowIcon(following)}<span class="lb-follow-text">${following ? 'Following' : 'Follow'}</span>`;
                btn.dataset.following = String(following);
              };
              setState(false);
              if (currentUser) {
                try {
                  const { doc: fd, getDoc: fg } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                  const fSnap = await fg(fd(window.__db, 'users', uid, 'followers', currentUser.uid));
                  setState(fSnap.exists());
                } catch (_) {}
              }
              btn.onclick = async (e) => {
                e.stopPropagation();
                const user = window.__auth?.currentUser;
                if (!user) { document.querySelector('.btn-login')?.click(); return; }
                try {
                  const { doc: fd, setDoc: fs, deleteDoc: fdel, serverTimestamp: fts } =
                    await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                  const isNowFollowing = btn.dataset.following === 'true';
                  const followerRef  = fd(window.__db, 'users', uid, 'followers', user.uid);
                  const followingRef = fd(window.__db, 'users', user.uid, 'following', uid);
                  if (isNowFollowing) {
                    await fdel(followerRef);
                    await fdel(followingRef);
                    seller.followerCount = Math.max(0, (seller.followerCount || 1) - 1);
                  } else {
                    const uData = window.__fbUserData || {};
                    const myName = uData.username || user.displayName || user.email?.split('@')[0] || 'Someone';
                    await fs(followerRef, { uid: user.uid, username: myName, pic: uData.profilePic || '', followedAt: fts() });
                    await fs(followingRef, { uid, username: seller.username, pic: seller.profilePic || '', followedAt: fts() });
                    seller.followerCount = (seller.followerCount || 0) + 1;
                  }
                  setState(!isNowFollowing);
                } catch (err) { console.error('Leaderboard follow error:', err); }
              };
            }

            async function lbOpenModal() {
              const modal = document.getElementById('lbModal');
              if (!modal) return;
              modal.classList.add('active');
              window.__srfLockScroll();
              document.getElementById('lbModalBody').scrollTop = 0;

              // Show cached rows instantly if we have them, then refresh quietly.
              if (_lbCache) {
                lbRenderRows(_lbCache);
              } else {
                document.getElementById('lbModalLoading').style.display = '';
                document.getElementById('lbModalList').innerHTML = document.getElementById('lbModalList').innerHTML; // no-op guard
              }
              try {
                const rows = await lbFetchTopSellers();
                _lbCache = rows;
                lbRenderRows(rows);
              } catch (err) {
                console.error('Leaderboard fetch error:', err);
                if (!_lbCache) {
                  document.getElementById('lbModalList').innerHTML = '';
                  const empty = document.getElementById('lbModalEmpty');
                  empty.textContent = "Couldn't load the leaderboard — try again in a moment.";
                  empty.style.display = '';
                }
              }
            }

            function lbCloseModal() {
              document.getElementById('lbModal')?.classList.remove('active');
              window.__srfUnlockScroll();
              if (location.pathname.replace(/\/+$/, '') === '/leaderboard') {
                window.__srfSetSectionPath?.('/');
              }
              if (typeof window.__seo?.applyHomeDefaults === 'function') window.__seo.applyHomeDefaults();
            }

            document.getElementById('lbModalClose')?.addEventListener('click', lbCloseModal);
            document.getElementById('lbModal')?.addEventListener('click', e => {
              if (e.target.id === 'lbModal') lbCloseModal();
            });
            window.__openLeaderboard = lbOpenModal;
            window.__closeLeaderboard = lbCloseModal;

            /* ── Rate Overlay ── */
            let _rateTargetUid   = null;
            let _rateTargetName  = '';
            let _rateStarVal     = 0;

            function _openRateOverlay(uid, name) {
              _rateTargetUid  = uid;
              _rateTargetName = name;
              _rateStarVal    = 0;
              // Reset UI
              document.querySelectorAll('.sp-rate-star').forEach(s => s.classList.remove('lit'));
              const ta = document.getElementById('spRateTextarea');
              if (ta) ta.value = '';
              const err = document.getElementById('spRateErr');
              if (err) { err.style.display = 'none'; err.textContent = ''; }
              const suc = document.getElementById('spRateSuccess');
              if (suc) suc.style.display = 'none';
              const sub = document.getElementById('spRateSubmitBtn');
              if (sub) { sub.disabled = true; sub.textContent = 'Submit Rating'; }
              const acts = document.getElementById('spRateActions');
              if (acts) acts.style.display = 'flex';
              document.getElementById('spRateTitle').textContent = `Rate ${name}`;
              document.getElementById('spRateOverlay').classList.add('active');
            }

            function _closeRateOverlay() {
              document.getElementById('spRateOverlay').classList.remove('active');
              _rateTargetUid = null;
            }

            /* ═══════════════════════════════════════
               DONATE OVERLAY
               ═══════════════════════════════════════ */
            // Fixed 15% platform fee, mirroring DONATION_FEE_RATE in
            // paypal.js — used here only to render the live "seller
            // receives" preview as the donor types. The server is the
            // actual source of truth and recomputes this independently;
            // this constant never affects what's actually charged.
            const DONATION_FEE_RATE_CLIENT = 0.15;
            let _donateTargetSeller = null;
            let _donateCache = {}; // uid → { totalDonated, donationCount, recent } — avoids
                                    // refetching the list every time the same seller's
                                    // donate modal is reopened in the same session

            function spOpenDonateOverlay(seller) {
              if (!seller) return;
              const user = window.__auth?.currentUser;
              if (!user) { document.querySelector('.btn-login')?.click(); return; }

              _donateTargetSeller = seller;

              document.getElementById('spDonateSellerName').textContent = seller.username;

              // Reset form
              const amtEl  = document.getElementById('spDonateAmt');
              const noteEl = document.getElementById('spDonateNote');
              const msgEl  = document.getElementById('spDonateMsg');
              const feeRow = document.getElementById('spDonateFeeRow');
              const submitBtn = document.getElementById('spDonateSubmitBtn');
              if (amtEl)  amtEl.value = '';
              if (noteEl) noteEl.value = '';
              if (msgEl)  { msgEl.textContent = ''; msgEl.className = 'wallet-msg'; }
              if (feeRow) feeRow.style.display = 'none';
              if (submitBtn) { submitBtn.disabled = false; submitBtn.querySelector('span').textContent = 'Donate'; }
              document.querySelectorAll('.sp-donate-quick-btn').forEach(btn => btn.classList.remove('active'));

              document.getElementById('spDonateOverlay').classList.add('active');
              window.__srfLockScroll();

              // Show cached totals/list instantly if we have them for this
              // seller already this session, then refresh quietly in the
              // background — same pattern as the leaderboard cache above.
              const cached = _donateCache[seller.uid];
              if (cached) {
                spRenderDonateSummary(cached);
              } else {
                spRenderDonateSummary(null, /*loading*/ true);
              }
              spLoadDonations(seller.uid);
            }

            function spCloseDonateOverlay() {
              document.getElementById('spDonateOverlay')?.classList.remove('active');
              window.__srfUnlockScroll();
              _donateTargetSeller = null;
            }

            async function spLoadDonations(sellerUid) {
              try {
                const resp = await fetch('/api/paypal', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'get-donations', sellerUid }),
                });
                const out = await resp.json();
                if (!resp.ok || !out.ok) throw new Error(out.error || 'Could not load donations');
                _donateCache[sellerUid] = out;
                // Only paint if the donor hasn't since closed the modal or
                // switched to a different seller's donate overlay.
                if (_donateTargetSeller && _donateTargetSeller.uid === sellerUid) {
                  spRenderDonateSummary(out);
                }
              } catch (err) {
                console.error('[spLoadDonations] failed', err);
                if (_donateTargetSeller && _donateTargetSeller.uid === sellerUid && !_donateCache[sellerUid]) {
                  spRenderDonateSummary(null);
                }
              }
            }

            function spRenderDonateSummary(data, loading) {
              const totalEl = document.getElementById('spDonateTotalVal');
              const countEl = document.getElementById('spDonateCountVal');
              const listEl  = document.getElementById('spDonateRecentList');
              const emptyEl = document.getElementById('spDonateRecentEmpty');

              if (loading) {
                totalEl.textContent = '—';
                countEl.textContent = '—';
                listEl.innerHTML = '<div class="sp-donate-skel"></div><div class="sp-donate-skel"></div><div class="sp-donate-skel"></div>';
                emptyEl.style.display = 'none';
                return;
              }

              if (!data) {
                totalEl.textContent = '—';
                countEl.textContent = '—';
                listEl.innerHTML = '';
                emptyEl.textContent = "Couldn't load donations — try again in a moment.";
                emptyEl.style.display = '';
                return;
              }

              const total = Number(data.totalDonated || 0);
              totalEl.textContent = '$' + total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              countEl.textContent = String(data.donationCount || 0);

              const recent = data.recent || [];
              if (!recent.length) {
                listEl.innerHTML = '';
                emptyEl.textContent = 'No donations yet — be the first!';
                emptyEl.style.display = '';
                return;
              }
              emptyEl.style.display = 'none';
              listEl.innerHTML = recent.map(spDonateRowHtml).join('');
            }

            function spDonateRowHtml(don) {
              const name = srEscapeHtml(don.donorName || 'Anonymous');
              const avatarInner = don.donorPic
                ? `<img src="${don.donorPic}" alt="${name}" onerror="this.parentElement.textContent='${name.charAt(0).toUpperCase()}'">`
                : name.charAt(0).toUpperCase();
              const amt = '$' + Number(don.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const when = don.createdAt
                ? new Date(don.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : '';
              return `
                <div class="sp-donate-row">
                   <div class="sp-donate-av">${avatarInner}</div>
                   <div class="sp-donate-mid">
                      <div class="sp-donate-name">${name}</div>
                      ${don.note ? `<div class="sp-donate-note">"${srEscapeHtml(don.note)}"</div>` : ''}
                      <div class="sp-donate-when">${when}</div>
                   </div>
                   <div class="sp-donate-amt">${amt}</div>
                </div>`;
            }

            document.getElementById('spDonateAmt')?.addEventListener('input', (e) => {
              const amt = parseFloat(e.target.value);
              const feeRow = document.getElementById('spDonateFeeRow');
              if (amt > 0) {
                const fee = amt * DONATION_FEE_RATE_CLIENT;
                const receive = amt - fee;
                document.getElementById('spDonateFee').textContent = '$' + fee.toFixed(2);
                document.getElementById('spDonateReceive').textContent = '$' + receive.toFixed(2);
                feeRow.style.display = 'flex';
              } else {
                feeRow.style.display = 'none';
              }
              // Un-highlight quick-amount chips if the user typed a custom
              // value that doesn't match any of them.
              document.querySelectorAll('.sp-donate-quick-btn').forEach(btn => {
                btn.classList.toggle('active', parseFloat(btn.dataset.amt) === amt);
              });
            });

            document.querySelectorAll('.sp-donate-quick-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const amtEl = document.getElementById('spDonateAmt');
                if (!amtEl) return;
                amtEl.value = btn.dataset.amt;
                amtEl.dispatchEvent(new Event('input', { bubbles: true }));
                amtEl.focus();
              });
            });

            document.getElementById('spDonateClose')?.addEventListener('click', spCloseDonateOverlay);
            document.getElementById('spDonateOverlay')?.addEventListener('click', e => {
              if (e.target === document.getElementById('spDonateOverlay')) spCloseDonateOverlay();
            });

            document.getElementById('spDonateSubmitBtn')?.addEventListener('click', async () => {
              const msgEl = document.getElementById('spDonateMsg');
              const submitBtn = document.getElementById('spDonateSubmitBtn');
              const amtEl = document.getElementById('spDonateAmt');
              const noteEl = document.getElementById('spDonateNote');
              msgEl.textContent = '';
              msgEl.className = 'wallet-msg';

              const user = window.__auth?.currentUser;
              if (!user) { spCloseDonateOverlay(); document.querySelector('.btn-login')?.click(); return; }
              if (!_donateTargetSeller) return;

              const amt = parseFloat(amtEl.value);
              if (!amt || amt < 1 || amt > 2500) {
                msgEl.textContent = 'Enter an amount between $1 and $2,500.';
                msgEl.className = 'wallet-msg err';
                return;
              }
              // window.__walletBal is exposed by the wallet module (a
              // separate <script type="module"> block, so this donate
              // code — defined in the seller-profile module — can't see
              // its top-level _walletBal directly). Fall back to
              // window.__fbUserData if the wallet module hasn't
              // initialized yet for any reason.
              const bal = typeof window.__walletBal === 'function'
                ? window.__walletBal()
                : Number(window.__fbUserData?.walletBalance || 0);
              if (amt > bal) {
                msgEl.textContent = `Insufficient balance — you have $${bal.toFixed(2)}.`;
                msgEl.className = 'wallet-msg err';
                return;
              }

              submitBtn.disabled = true;
              const prevLabel = submitBtn.querySelector('span').textContent;
              submitBtn.querySelector('span').textContent = 'Donating…';

              try {
                const idToken = await user.getIdToken();
                const res = await fetch('/api/paypal', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'donate',
                    idToken,
                    sellerUid: _donateTargetSeller.uid,
                    amount: amt,
                    note: noteEl.value.trim(),
                  }),
                });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || 'Donation failed');

                // Keep the wallet balance in sync everywhere it's shown —
                // via the window.__wallet* bridge exposed by the wallet
                // module (see note on the balance check above for why
                // this can't just call the module-local functions directly).
                if (window.__fbUserData) window.__fbUserData.walletBalance = result.newBalance;
                if (window.__walletSummaryRef) {
                  window.__walletSummaryRef.walletBalance = result.newBalance;
                  window.__walletSummaryRef.withdrawableBalance = result.newWithdrawable;
                }
                if (typeof window.__walletRenderBalance === 'function') window.__walletRenderBalance();
                if (typeof window.__walletSyncHeaderBalance === 'function') window.__walletSyncHeaderBalance(result.newBalance);
                if (typeof window.__walletMarkHistoryStale === 'function') window.__walletMarkHistoryStale();

                msgEl.textContent = `✓ Donated $${amt.toFixed(2)} to ${result.sellerName}. Thank you!`;
                msgEl.className = 'wallet-msg ok';
                amtEl.value = '';
                noteEl.value = '';
                document.getElementById('spDonateFeeRow').style.display = 'none';

                // Drop the cache for this seller and reload so the new
                // donation shows up at the top of the recent list and the
                // total/count reflect it immediately.
                delete _donateCache[_donateTargetSeller.uid];
                spLoadDonations(_donateTargetSeller.uid);
              } catch (err) {
                console.error('[donate]', err);
                msgEl.textContent = err.message || 'Something went wrong. Please try again.';
                msgEl.className = 'wallet-msg err';
              } finally {
                submitBtn.disabled = false;
                submitBtn.querySelector('span').textContent = prevLabel;
              }
            });

            // Star hover + click
            document.querySelectorAll('.sp-rate-star').forEach(star => {
              star.addEventListener('mouseover', () => {
                const v = parseInt(star.dataset.v);
                document.querySelectorAll('.sp-rate-star').forEach(s => {
                  s.classList.toggle('lit', parseInt(s.dataset.v) <= v);
                });
              });
              star.addEventListener('mouseleave', () => {
                document.querySelectorAll('.sp-rate-star').forEach(s => {
                  s.classList.toggle('lit', parseInt(s.dataset.v) <= _rateStarVal);
                });
              });
              star.addEventListener('click', () => {
                _rateStarVal = parseInt(star.dataset.v);
                document.querySelectorAll('.sp-rate-star').forEach(s => {
                  s.classList.toggle('lit', parseInt(s.dataset.v) <= _rateStarVal);
                });
                const sub = document.getElementById('spRateSubmitBtn');
                if (sub) sub.disabled = false;
              });
            });

            document.getElementById('spRateCancelBtn')?.addEventListener('click', _closeRateOverlay);
            document.getElementById('spRateOverlay')?.addEventListener('click', e => {
              if (e.target === document.getElementById('spRateOverlay')) _closeRateOverlay();
            });

            document.getElementById('spRateSubmitBtn')?.addEventListener('click', async () => {
              const user = window.__auth?.currentUser;
              if (!user) { _closeRateOverlay(); document.querySelector('.btn-login')?.click(); return; }
              if (!_rateTargetUid || _rateStarVal < 1) return;
              if (_rateTargetUid === user.uid) {
                const errEl = document.getElementById('spRateErr');
                if (errEl) { errEl.textContent = "You can't rate yourself."; errEl.style.display = 'block'; }
                return;
              }
              const subBtn = document.getElementById('spRateSubmitBtn');
              subBtn.disabled = true;
              subBtn.textContent = 'Submitting…';
              try {
                const { doc, setDoc, getDoc, runTransaction, serverTimestamp, collection } =
                  await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                const db = window.__db;
                const reviewId = user.uid; // one review per user per seller
                const reviewRef = doc(db, 'users', _rateTargetUid, 'reviews', reviewId);
                const uData = window.__fbUserData || {};
                const myName = uData.username || user.displayName || user.email?.split('@')[0] || 'Anonymous';
                const review = document.getElementById('spRateTextarea')?.value.trim() || '';

                // Check if user already rated this seller
                const existing = await getDoc(reviewRef);
                const oldStars = existing.exists() ? (existing.data().stars || 0) : 0;

                // Write review doc
                await setDoc(reviewRef, {
                  reviewerId: user.uid,
                  reviewerName: myName,
                  reviewerPic: uData.profilePic || '',
                  stars: _rateStarVal,
                  review,
                  updatedAt: serverTimestamp(),
                }, { merge: true });

                // Recompute seller's average using transaction
                await runTransaction(db, async tx => {
                  const sellerRef = doc(db, 'users', _rateTargetUid);
                  const sellerSnap = await tx.get(sellerRef);
                  const sd = sellerSnap.data() || {};
                  let cnt = typeof sd.ratingCount === 'number' ? sd.ratingCount : 0;
                  let total = (typeof sd.rating === 'number' ? sd.rating : 0) * cnt;
                  if (existing.exists()) {
                    // Replace old rating
                    total = total - oldStars + _rateStarVal;
                  } else {
                    // New rating
                    cnt = cnt + 1;
                    total = total + _rateStarVal;
                  }
                  const newAvg = cnt > 0 ? Math.round((total / cnt) * 10) / 10 : 0;
                  tx.update(sellerRef, { rating: newAvg, ratingCount: cnt });
                });

                // Update stat display immediately
                document.getElementById('spStatRating').textContent = _rateStarVal.toFixed(1);

                // Show success, hide actions
                const suc = document.getElementById('spRateSuccess');
                const acts = document.getElementById('spRateActions');
                if (suc) suc.style.display = 'block';
                if (acts) acts.style.display = 'none';
                setTimeout(_closeRateOverlay, 1800);
              } catch(e) {
                const errEl = document.getElementById('spRateErr');
                if (errEl) { errEl.textContent = 'Failed to submit. Try again.'; errEl.style.display = 'block'; }
                subBtn.disabled = false;
                subBtn.textContent = 'Submit Rating';
              }
            });
            
            // ── View site in iframe ──
            function mpOpenPreview(url) {
              const preview  = document.getElementById('mpSitePreview');
              const frame    = document.getElementById('mpSiteFrame');
              const spinner  = document.getElementById('mpPreviewSpinner');
              if (!preview || !frame) return;
              // Show spinner, hide iframe until loaded
              if (spinner) spinner.classList.remove('hidden');
              frame.style.opacity = '0';
              // Set src and listen for load
              frame.onload = function() {
                if (spinner) spinner.classList.add('hidden');
                frame.style.opacity = '1';
              };
              frame.src = url;
              preview.style.display = 'flex';
              preview.style.flexDirection = 'column';
              // Fresh impression every time preview opens
              _mpLoadAd('mpPreviewTopAd',    '837d8d50ffa851dddd18e0f1d01833aa', 320, 50);
            }
            function mpClosePreview() {
              const preview = document.getElementById('mpSitePreview');
              const frame   = document.getElementById('mpSiteFrame');
              const spinner = document.getElementById('mpPreviewSpinner');
              if (preview) preview.style.display = 'none';
              if (frame)   { frame.src = ''; frame.onload = null; frame.style.opacity = '0'; }
              if (spinner) spinner.classList.remove('hidden');
              // Clear ad slots so stale iframes don't persist
              const topAd = document.getElementById('mpPreviewTopAd');
              if (topAd) topAd.innerHTML = '';
            }
            document.getElementById('mpPreviewClose')?.addEventListener('click', mpClosePreview);
            document.getElementById('mpModalViewSiteBtn')?.addEventListener('click', () => {
              if (_currentListing?.url) mpShowAdThenAction('Preview: ' + (_currentListing.title||'Site'), () => mpOpenPreview(_currentListing.url));
            });


            // ── Save button state helper (spinner → done ✅ → reset) ──
            // Exposed on window so non-module scripts (settings IIFE etc.) can use them
            const _srfOriginalBtnHTML = new WeakMap();
            window._btnSaveStart = function(btn, savingLabel) {
              if (!_srfOriginalBtnHTML.has(btn)) _srfOriginalBtnHTML.set(btn, btn.innerHTML);
              btn.disabled = true;
              btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:srf-spin .7s linear infinite"><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg> ${savingLabel || 'Saving…'}`;
            };
            window._setBtnDone = function(btn, label) {
              btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${label || 'Saved'}`;
              setTimeout(() => {
                btn.disabled = false;
                btn.innerHTML = _srfOriginalBtnHTML.get(btn) || btn.innerHTML;
              }, 2000);
            };
            window._setBtnError = function(btn) {
              btn.disabled = false;
              btn.innerHTML = _srfOriginalBtnHTML.get(btn) || btn.innerHTML;
            };
            // Local aliases for use within this module
            const originalBtnHTML = _srfOriginalBtnHTML;
            function _setBtnSaving(btn, label) { window._btnSaveStart(btn, label); }
            function _setBtnDoneLocal(btn, label) { window._setBtnDone(btn, label); }
            function _setBtnErrorLocal(btn) { window._setBtnError(btn); }
            function _btnSaveStartLocal(btn, savingLabel) { window._btnSaveStart(btn, savingLabel); }
            // ── Ad refresh helper — destroys and re-injects ad scripts for a fresh impression ──
            function _mpLoadAd(containerId, key, width, height) {
              const el = document.getElementById(containerId);
              if (!el) return;
              // Wipe previous ad completely
              el.innerHTML = '';
              // Small delay lets the DOM clear before the new script runs
              setTimeout(() => {
                const cfg = document.createElement('script');
                cfg.textContent = [
                  "atOptions = {",
                  "  'key': '" + key + "',",
                  "  'format': 'iframe',",
                  "  'height': " + height + ",",
                  "  'width': " + width + ",",
                  "  'params': {}",
                  "};"
                ].join('\n');
                const inv = document.createElement('script');
                inv.src = 'https://beavercolourfuldelinquent.com/' + key + '/invoke.js';
                el.appendChild(cfg);
                el.appendChild(inv);
              }, 50);
            }

            // ── Ad countdown overlay ──
            let _mpAdTimer = null;
            function mpShowAdThenAction(titleText, onComplete) {
              // Detect plan — only show ads for free plan
              const plan = (window.__fbUserData?.plan || 'free').toLowerCase();
              if (plan !== 'free') { onComplete(); return; }

              const overlay   = document.getElementById('mpAdOverlay');
              const titleEl   = document.getElementById('mpAdOverlayTitleText');
              const fill      = document.getElementById('mpAdCountdownFill');
              const countEl   = document.getElementById('mpAdCountdownText');
              const skipBtn   = document.getElementById('mpAdSkipBtn');
              const removeBtn = document.getElementById('mpAdOverlayRemoveAds');
              if (!overlay) { onComplete(); return; }

              if (_mpAdTimer) clearInterval(_mpAdTimer);
              titleEl.textContent = titleText;
              skipBtn.style.display = 'none';
              fill.style.transform = 'scaleX(1)';
              countEl.textContent = '10s';
              removeBtn.style.display = 'flex';

              overlay.classList.add('active');
              // Fresh impression every time the overlay opens
              _mpLoadAd('mpAdBox', '02d530955f964bb754200c047d5cab26', 300, 250);

              let sec = 10;
              _mpAdTimer = setInterval(() => {
                sec--;
                fill.style.transform = `scaleX(${sec / 10})`;
                countEl.textContent = sec > 0 ? sec + 's' : 'Done!';
                if (sec <= 0) {
                  clearInterval(_mpAdTimer);
                  skipBtn.style.display = 'block';
                  skipBtn.onclick = () => {
                    overlay.classList.remove('active');
                    onComplete();
                  };
                }
              }, 1000);

              // Remove Ads → upgrade flow
              removeBtn.onclick = () => {
                overlay.classList.remove('active');
                clearInterval(_mpAdTimer);
                window.__openPlansModal?.();
              };
            }
            window.mpShowAdThenAction = mpShowAdThenAction;

            // Preview remove-ads button in the site preview header
            document.getElementById('mpPreviewRemoveAds')?.addEventListener('click', () => {
              window.__openPlansModal?.();
            });
            // Show/hide that button based on plan
            (function syncPreviewAdsBtn() {
              const btn = document.getElementById('mpPreviewRemoveAds');
              if (!btn) return;
              const check = () => {
                const plan = (window.__fbUserData?.plan || 'free').toLowerCase();
                btn.style.display = plan === 'free' ? 'flex' : 'none';
              };
              check();
              const orig = window.__onUserDataReady;
              window.__onUserDataReady = (d) => { if(orig) orig(d); check(); };
            })();
            
            // ── Send Deal popup ──
            let _dealListing = null;
            const MP_DEAL_SUBMIT_HTML = `
                     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke-linecap="round" stroke-linejoin="round"/>
                     </svg>
                     Send Deal`;
            
            function mpOpenDeal(listing) {
              if (!window.__auth?.currentUser) {
                document.querySelector('.btn-login')?.click();
                return;
              }
              _dealListing = listing;
              const popup      = document.getElementById('mpDealPopup');
              const buyerAvEl  = document.getElementById('mpDealBuyerAv');
              const buyerName  = document.getElementById('mpDealBuyerName');
              const introEl    = document.getElementById('mpDealIntro');
              const msgEl      = document.getElementById('mpDealMsg');
              const charEl     = document.getElementById('mpDealChar');
              const errEl      = document.getElementById('mpDealErr');
              const submitEl   = document.getElementById('mpDealSubmit');
              const successEl  = document.getElementById('mpDealSuccess');
              const prevImg    = document.getElementById('mpDealPrevImg');
              const prevUid    = document.getElementById('mpDealPrevUid');
              const prevTitle  = document.getElementById('mpDealPrevTitle');
              const prevDesc   = document.getElementById('mpDealPrevDesc');
              const prevPrice  = document.getElementById('mpDealPrevPrice');
            
              // Reset state
              if (msgEl)     { msgEl.value = ''; }
              if (charEl)    { charEl.textContent = '0 / 30 min'; charEl.classList.remove('ok'); }
              if (errEl)     { errEl.style.display = 'none'; errEl.textContent = ''; }
              if (successEl) { successEl.style.display = 'none'; }
              if (submitEl)  { submitEl.style.display = ''; submitEl.disabled = false; submitEl.innerHTML = MP_DEAL_SUBMIT_HTML; }
              // Reset offer input
              const offerInput = document.getElementById('mpDealOfferInput');
              if (offerInput) offerInput.value = '';
              const listedBox = document.getElementById('mpDealListedBox');
              if (listedBox) listedBox.textContent = typeof listing.financials?.price === 'number' ? '$' + Number(listing.financials.price).toLocaleString() : '—';
            
              // Buyer info
              const user = window.__auth.currentUser;
              const uData = window.__fbUserData || {};
              const bName = uData.username || user.displayName || user.email?.split('@')[0] || 'You';
              if (buyerName) buyerName.textContent = bName;
              if (buyerAvEl) {
                if (uData.profilePic) {
                  buyerAvEl.innerHTML = `<img src="${uData.profilePic}" alt="${bName}">`;
                } else {
                  buyerAvEl.textContent = bName.charAt(0).toUpperCase();
                }
              }
            
              // Hardcoded intro message — type-aware
              const typeWord = listing.type === 'app' ? 'app' : listing.type === 'game' ? 'game' : 'website';
              if (introEl) introEl.textContent = `Hi! I'm interested in this ${typeWord} — is it still available?`;
            
              // Preview card
              const cover    = listing.images?.[2] || listing.imageCover || listing.images?.[0] || '';
              const lTitle   = listing.title || 'Untitled';
              const lDesc    = listing.description || '';
              const lPrice   = typeof listing.financials?.price === 'number' ? `$${listing.financials.price.toLocaleString()}` : '—';
              const lId      = listing.id ? listing.id.slice(0,8).toUpperCase() : '—';
              if (prevImg)   { prevImg.src = cover; prevImg.onerror = () => prevImg.style.display='none'; }
              if (prevUid)   prevUid.textContent  = 'ID: ' + lId;
              if (prevTitle) prevTitle.textContent = lTitle;
              if (prevDesc)  prevDesc.textContent  = lDesc.slice(0,80) + (lDesc.length>80?'…':'');
              if (prevPrice) prevPrice.textContent = lPrice;
            
              popup.style.display = 'flex';
            }
            
            function mpCloseDeal() {
              const popup = document.getElementById('mpDealPopup');
              if (popup) popup.style.display = 'none';
              const submitEl = document.getElementById('mpDealSubmit');
              if (submitEl) { submitEl.disabled = false; submitEl.innerHTML = MP_DEAL_SUBMIT_HTML; submitEl.style.display = ''; }
              _dealListing = null;
            }

            // ── Deal Outcome popup (green=accepted, red=rejected, yellow=pending) ──
            let _outcomeCountdownTimer = null;

            function _mpOutcomeStartCountdown() {
              // In-memory only — never persisted, so it resets/disappears once the
              // popup is closed and re-shown, exactly like the rest of this UI.
              clearInterval(_outcomeCountdownTimer);
              let secondsLeft = 2 * 60 * 60; // 2:00:00
              const timerEl = document.getElementById('mpOutcomeTimer');
              const render = () => {
                const h = Math.floor(secondsLeft / 3600);
                const m = Math.floor((secondsLeft % 3600) / 60);
                const s = secondsLeft % 60;
                if (timerEl) timerEl.textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
              };
              render();
              _outcomeCountdownTimer = setInterval(() => {
                secondsLeft = Math.max(0, secondsLeft - 1);
                render();
                if (secondsLeft <= 0) clearInterval(_outcomeCountdownTimer);
              }, 1000);
            }

            function mpCloseDealOutcome() {
              const popup = document.getElementById('mpDealOutcomePopup');
              if (popup) popup.style.display = 'none';
              clearInterval(_outcomeCountdownTimer);
            }

            function _mpRenderOutcome(state) {
              // state: 'accept' | 'reject' | 'pending'
              const popup    = document.getElementById('mpDealOutcomePopup');
              const box      = document.getElementById('mpOutcomeBox');
              const title    = document.getElementById('mpOutcomeTitle');
              const sub      = document.getElementById('mpOutcomeSub');
              const timerWrap= document.getElementById('mpOutcomeTimerWrap');
              const iAccept  = document.getElementById('mpOutcomeIconAccept');
              const iReject  = document.getElementById('mpOutcomeIconReject');
              const iPending = document.getElementById('mpOutcomeIconPending');
              if (!popup || !box) return;

              box.classList.remove('theme-accept', 'theme-reject', 'theme-pending');
              iAccept.style.display  = 'none';
              iReject.style.display  = 'none';
              iPending.style.display = 'none';
              timerWrap.style.display = 'none';
              clearInterval(_outcomeCountdownTimer);

              if (state === 'accept') {
                box.classList.add('theme-accept');
                iAccept.style.display = '';
                title.textContent = 'Offer accepted!';
                sub.textContent   = "The seller's agent approved your deal. Head to your inbox to coordinate next steps.";
              } else if (state === 'reject') {
                box.classList.add('theme-reject');
                iReject.style.display = '';
                title.textContent = 'Offer rejected';
                sub.textContent   = "The seller's agent declined this offer. You can send a new deal with a different offer anytime.";
              } else {
                box.classList.add('theme-pending');
                iPending.style.display = '';
                title.textContent = 'Offer pending';
                sub.textContent   = 'The seller has no auto agent — they\u2019ll accept or reject your offer when they come back online.';
                timerWrap.style.display = 'flex';
                _mpOutcomeStartCountdown();
              }

              popup.style.display = 'flex';
            }

            /**
             * Decide which popup to show for a just-sent deal:
             *  - No active seller agent              → yellow "pending" (no agent online)
             *  - Active agent, deal already decided  → green / red
             *  - Active agent, but still pending      → yellow "pending" as well —
             *    covers the agent being rate-limited, the AI provider being down,
             *    or any other transient failure. We don't try to tell those apart
             *    for the buyer; "pending" is accurate either way.
             */
            async function mpShowDealOutcome({ db, sellerUid, buyerUid, dealId }) {
              try {
                const { doc, getDoc, onSnapshot } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');

                const sellerSnap = await getDoc(doc(db, 'users', sellerUid));
                const agentActive = !!(sellerSnap.exists() && sellerSnap.data()?.agentConfig?.active);

                if (!agentActive) {
                  _mpRenderOutcome('pending');
                  return;
                }

                // Seller has an active agent — give it a short window to act (the
                // instant POST already fired; this just waits for Firestore to
                // reflect the result). If nothing lands in time, fall back to
                // "pending" — covers quota limits, a down AI provider, etc.
                const dealRef = doc(db, 'users', buyerUid, 'deals', dealId);
                let settled = false;

                const finish = (status) => {
                  if (settled) return;
                  settled = true;
                  unsub();
                  clearTimeout(fallbackTimer);
                  if (status === 'accepted') _mpRenderOutcome('accept');
                  else if (status === 'rejected') _mpRenderOutcome('reject');
                  else _mpRenderOutcome('pending');
                };

                const unsub = onSnapshot(dealRef, snap => {
                  const status = snap.exists() ? snap.data()?.status : null;
                  if (status === 'accepted' || status === 'rejected') finish(status);
                }, () => finish('pending'));

                const fallbackTimer = setTimeout(() => finish('pending'), 6000);
              } catch (err) {
                console.error('[deal-outcome] error', err);
                _mpRenderOutcome('pending');
              }
            }

            document.getElementById('mpOutcomeClose')?.addEventListener('click', mpCloseDealOutcome);
            document.getElementById('mpOutcomeOk')?.addEventListener('click', mpCloseDealOutcome);
            document.getElementById('mpDealOutcomePopup')?.addEventListener('click', e => {
              if (e.target === document.getElementById('mpDealOutcomePopup')) mpCloseDealOutcome();
            });
            
            // Deal textarea live counter
            document.getElementById('mpDealMsg')?.addEventListener('input', () => {
              const len  = document.getElementById('mpDealMsg').value.length;
              const el   = document.getElementById('mpDealChar');
              if (el) { el.textContent = `${len} / 30 min`; el.classList.toggle('ok', len >= 30); }
            });
            
            // Deal submit
            document.getElementById('mpDealSubmit')?.addEventListener('click', async () => {
              const listing  = _dealListing;
              if (!listing)  return;
              const user     = window.__auth?.currentUser;
              if (!user) { document.querySelector('.btn-login')?.click(); return; }
            
              const msgEl    = document.getElementById('mpDealMsg');
              const errEl    = document.getElementById('mpDealErr');
              const submitEl = document.getElementById('mpDealSubmit');
              const msg      = msgEl?.value.trim() || '';
            
              errEl.style.display = 'none';
              const dealMsgMin = window.__limits?.deals?.messageMinLength ?? 30;
              if (msg.length < dealMsgMin) {
                errEl.textContent   = `Please write at least ${dealMsgMin} characters in your message.`;
                errEl.style.display = 'block';
                return;
              }
            
              submitEl.disabled    = true;
              submitEl.textContent = 'Sending…';
              const _dealSendTimeout = setTimeout(() => {
                // Safety net: if something hangs without throwing (e.g. a stalled
                // network promise that never resolves/rejects), don't leave the
                // button stuck forever — restore it after 15s.
                if (submitEl.disabled && submitEl.textContent.includes('Sending')) {
                  submitEl.disabled = false;
                  submitEl.innerHTML = MP_DEAL_SUBMIT_HTML;
                }
              }, 15000);
            
              try {
                const user2     = window.__auth.currentUser;
                const idToken   = await user2.getIdToken();

                // Parse offer amount (optional)
                const offerRaw   = parseFloat(document.getElementById('mpDealOfferInput')?.value);
                const offerPrice = (!isNaN(offerRaw) && offerRaw > 0) ? offerRaw : null;

                // Server is the source of truth here: it re-fetches the listing
                // itself (never trusts price/title/owner from the client), checks
                // for an existing pending deal on this listing (duplicate
                // prevention), and writes both deal copies atomically.
                const resp = await fetch('/api/deal', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'create-deal',
                    idToken,
                    listingId: listing.id,
                    message: msg,
                    offerPrice,
                  }),
                });
                const out = await resp.json();
                if (!resp.ok) {
                  // 409 = duplicate pending deal already exists on this listing
                  throw new Error(out.error || 'Something went wrong. Please try again.');
                }
                const dealId = out.dealId;
                const sellerUid = listing.ownerId;
                const db = window.__db;

                // Show success animation
                clearTimeout(_dealSendTimeout);
                submitEl.style.display = 'none';
                const successEl = document.getElementById('mpDealSuccess');
                successEl.style.display = 'flex';
                // Spawn leaves
                const leavesEl = document.getElementById('mpDealLeaves');
                leavesEl.innerHTML = '';
                for (let i = 0; i < 14; i++) {
                  const leaf = document.createElement('div');
                  leaf.className = 'mp-leaf';
                  leaf.style.cssText = `
                    left:${20 + Math.random()*60}%;
                    top:${10 + Math.random()*30}%;
                    animation-delay:${(Math.random()*0.6).toFixed(2)}s;
                    animation-duration:${(1.1+Math.random()*0.8).toFixed(2)}s;
                    width:${8+Math.random()*8}px;
                    height:${11+Math.random()*8}px;
                    background:${Math.random()>0.4?'#a3e635':Math.random()>0.5?'#86efac':'#4ade80'};
                    transform:rotate(${Math.random()*360}deg);
                  `;
                  leavesEl.appendChild(leaf);
                }

                // After the success tick, check whether the seller's agent acted
                // on the deal (accepted/rejected) or whether it's just pending.
                setTimeout(() => {
                  mpCloseDeal();
                  mpShowDealOutcome({ db, sellerUid, buyerUid: user2.uid, dealId });
                }, 1400);
              } catch (err) {
                console.error('Deal send error:', err);
                clearTimeout(_dealSendTimeout);
                errEl.textContent   = err.message || 'Something went wrong. Please try again.';
                errEl.style.display = 'block';
                submitEl.disabled   = false;
                submitEl.innerHTML  = MP_DEAL_SUBMIT_HTML;
              }
            });
            
            document.getElementById('mpDealClose')?.addEventListener('click', mpCloseDeal);
            document.getElementById('mpDealPopup')?.addEventListener('click', e => { if (e.target===document.getElementById('mpDealPopup')) mpCloseDeal(); });
            
            // Wire modal buttons
            document.getElementById('mpModalClose')?.addEventListener('click', () => {
              mpCloseModal();
              // Only the listing's own URL should be cleared here — if the
              // user got here via a direct /listing/:id link, closing lands
              // them back on the marketplace rather than a bare listing URL.
              if (location.pathname.replace(/\/+$/, '').startsWith('/listing/')) {
                window.__srfSetSectionPath?.('/marketplace');
              }
            });
            document.getElementById('mpModalShareBtn')?.addEventListener('click', () => {
              if (_currentListing && typeof window.__openShareModal === 'function') {
                window.__openShareModal(_currentListing);
              }
            });
            document.getElementById('mpModalReportBtn')?.addEventListener('click', () => {
              if (_currentListing && typeof window.__openReportListing === 'function') {
                window.__openReportListing(_currentListing);
              }
            });
            document.getElementById('mpModalDealBtn')?.addEventListener('click', () => { if (_currentListing) mpOpenDeal(_currentListing); });
            document.getElementById('mpModalMsgBtn')?.addEventListener('click', () => {
              // Open chat if available, else fall back to deal
              if (_currentListing) mpOpenDeal(_currentListing);
            });
            
            // full-screen — no backdrop click to close
            document.addEventListener('keydown', e => {
              if (e.key==='Escape') {
                if (document.getElementById('mpSitePreview')?.style.display !== 'none') { mpClosePreview(); return; }
                if (document.getElementById('mpDealOutcomePopup')?.style.display !== 'none') { mpCloseDealOutcome(); return; }
                if (document.getElementById('mpDealPopup')?.style.display !== 'none') { mpCloseDeal(); return; }
                if (mpModal.classList.contains('active')) {
                  mpCloseModal();
                  if (location.pathname.replace(/\/+$/, '').startsWith('/listing/')) {
                    window.__srfSetSectionPath?.('/marketplace');
                  }
                  return;
                }
              }
            });
            
            // ── Load listings from Firestore — paginated ──
            // REQUIRED Firestore composite indexes (create in Firebase Console → Firestore → Indexes):
            //
            //   Index 1 — base feed (all types):
            //     Collection: listings
            //     Fields: status ASC, createdAt DESC
            //
            //   Index 2 — type-filtered feed (website / app / game):
            //     Collection: listings
            //     Fields: status ASC, type ASC, createdAt DESC
            //
            // Both indexes use Query scope: Collection

            // ── Top Sellers strip (horizontal scroll, above the grid) ──
            // Reuses the same ranked data as the full leaderboard modal
            // (lbFetchTopSellers), just rendered as compact scrollable cards.
            let _mpTopSellersFetching = false; // guards against the same
            // eager-load-vs-router-open race described above mpLoadListings
            async function mpLoadTopSellers() {
              if (_mpTopSellersFetching || mpTopSellersLoaded) return;
              _mpTopSellersFetching = true;
              const section = document.getElementById('mpTopSellersSection');
              if (!section) { _mpTopSellersFetching = false; return; }
              try {
                const rows = await lbFetchTopSellers();
                mpTopSellersLoaded = true;
                if (!rows.length) {
                  section.classList.add('mp-ts-empty');
                  return;
                }
                mpRenderTopSellers(rows);
              } catch (err) {
                console.error('[mpLoadTopSellers] failed', err);
                mpTopSellersLoaded = true;
                section.classList.add('mp-ts-empty');
              } finally {
                _mpTopSellersFetching = false;
              }
            }

            function mpRenderTopSellers(rows) {
              const track = document.getElementById('mpTopSellersTrack');
              if (!track) return;
              const myUid = window.__auth?.currentUser?.uid;

              track.innerHTML = rows.map((row, i) => {
                const { seller, listingCount, uid } = row;
                const avatarInner = seller.profilePic
                  ? `<img src="${seller.profilePic}" alt="${seller.username}" onerror="this.parentElement.textContent='${seller.username.charAt(0).toUpperCase()}'">`
                  : seller.username.charAt(0).toUpperCase();
                const isSelf = myUid && myUid === uid;

                return `
                  <div class="mp-ts-card" data-uid="${uid}">
                     <div class="mp-ts-av">${avatarInner}</div>
                     <div class="mp-ts-name"><span class="mp-ts-name-text">${srEscapeHtml(seller.username)}</span>${sellerBadgesHtml(seller)}</div>
                     <div class="mp-ts-meta">${listingCount} listing${listingCount === 1 ? '' : 's'}</div>
                     ${isSelf ? '' : `<button class="mp-ts-follow-btn" data-uid="${uid}">Follow</button>`}
                  </div>`;
              }).join('');

              // Row click (excluding the follow button) opens the seller's full profile.
              track.querySelectorAll('.mp-ts-card').forEach(cardEl => {
                cardEl.addEventListener('click', (e) => {
                  if (e.target.closest('.mp-ts-follow-btn')) return;
                  mpOpenSellerModal(cardEl.dataset.uid);
                });
              });

              // Wire each follow button independently, mirroring the leaderboard's logic.
              track.querySelectorAll('.mp-ts-follow-btn').forEach(btn => {
                mpWireTopSellerFollowBtn(btn, rows.find(r => r.uid === btn.dataset.uid)?.seller);
              });
            }

            async function mpWireTopSellerFollowBtn(btn, seller) {
              if (!btn || !seller) return;
              const uid = btn.dataset.uid;
              const currentUser = window.__auth?.currentUser;
              const setState = (following) => {
                btn.classList.toggle('mp-ts-following', following);
                btn.textContent = following ? 'Following' : 'Follow';
                btn.dataset.following = String(following);
              };
              setState(false);
              if (currentUser) {
                try {
                  const { doc: fd, getDoc: fg } = await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                  const fSnap = await fg(fd(window.__db, 'users', uid, 'followers', currentUser.uid));
                  setState(fSnap.exists());
                } catch (_) {}
              }
              btn.onclick = async (e) => {
                e.stopPropagation();
                const user = window.__auth?.currentUser;
                if (!user) { window.__requireAuth?.(() => {}); return; }
                try {
                  const { doc: fd, setDoc: fs, deleteDoc: fdel, serverTimestamp: fts } =
                    await import('https://www.gstatic.com/firebasejs/11.9.0/firebase-firestore.js');
                  const isNowFollowing = btn.dataset.following === 'true';
                  const followerRef  = fd(window.__db, 'users', uid, 'followers', user.uid);
                  const followingRef = fd(window.__db, 'users', user.uid, 'following', uid);
                  if (isNowFollowing) {
                    await fdel(followerRef);
                    await fdel(followingRef);
                  } else {
                    const uData = window.__fbUserData || {};
                    const myName = uData.username || user.displayName || user.email?.split('@')[0] || 'Someone';
                    await fs(followerRef, { uid: user.uid, username: myName, pic: uData.profilePic || '', followedAt: fts() });
                    await fs(followingRef, { uid, username: seller.username, pic: seller.profilePic || '', followedAt: fts() });
                  }
                  setState(!isNowFollowing);
                } catch (err) { console.error('Top sellers follow error:', err); }
              };
            }

            async function mpLoadListings(reset = true) {
              // Guard set SYNCHRONOUSLY, before any "await", so two callers
              // invoked back-to-back in the same tick (e.g. the eager
              // page-load kickoff and the path-router's __openMarketplace,
              // both waiting on window.__authReady and firing in the same
              // microtask flush) can't both pass the "already fetching"
              // check before either has had a chance to set it — that race
              // was causing listings to be fetched (and appended) twice on
              // a direct /marketplace visit. A reset explicitly clears it
              // first since a fresh load is allowed to interrupt an old one.
              if (reset) _mpFetching = false;
              if (_mpFetching || (!reset && _mpExhausted)) return;
              _mpFetching = true;

              const user = window.__auth?.currentUser;
              // Browsing is public — a signed-out visitor can still view
              // listings, so we don't bail here. idToken is included only
              // when available; the server treats it as an optional guest
              // request otherwise.

              if (reset) {
                _mpCursor    = null;
                _mpSeed      = null;
                _mpExhausted = false;
                mpListings   = [];
                mpClearSkeletonCards();
                mpError.style.display  = 'none';
                mpEmpty.style.display  = 'none';
                mpShowSkeletonCards();
                _setupSentinel();
              }

              const spinner = document.getElementById('mpLoadMoreSpinner');
              if (spinner && !reset) spinner.classList.add('active');

              try {
                // Ordering/shuffling is entirely server-owned now (see
                // /api/listings listing.feed) — the client never reorders
                // what it receives, only renders it as-is. _mpSeed makes the
                // shuffle stable and non-repeating across pages within this
                // browsing session; a fresh session (reset) gets a fresh
                // random seed from the server automatically.
                const idToken = user ? await user.getIdToken() : undefined;
                const res = await fetch('/api/listings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action:   'listing.feed',
                    ...(idToken ? { idToken } : {}),
                    seed:     _mpSeed,
                    cursor:   _mpCursor,
                    pageSize: MP_PAGE_SIZE,
                    ...(mpTypeFilter && mpTypeFilter !== 'all' ? { type: mpTypeFilter } : {}),
                  }),
                });
                const d = await res.json();
                if (!res.ok || !d.ok) throw new Error(d?.error?.message || 'Could not load listings');

                const page = d.data.listings || [];
                _mpSeed      = d.data.seed;
                _mpCursor    = d.data.cursor;
                _mpExhausted = !!d.data.exhausted;

                page.forEach(item => mpListings.push(item));

                mpClearSkeletonCards();
                if (spinner) spinner.classList.remove('active');
                mpApplyAndRender(reset);
                if (reset) mpRenderSuggestions();
                mpLoaded = true;
              } catch (err) {
                console.error('Marketplace load error:', err);
                mpClearSkeletonCards();
                if (spinner) spinner.classList.remove('active');
                if (reset && mpResultCount) mpResultCount.textContent = '—';
                const errDesc = document.querySelector('#mpError .mp-state-desc');
                if (errDesc) errDesc.textContent = 'Could not load listings. Tap Try Again.';
                mpError.style.display = 'flex';
                mpLoaded = false;
              } finally {
                _mpFetching = false;
              }
            }

            function _setupSentinel() {
              if (_mpObserver) _mpObserver.disconnect();
              const sentinel = document.getElementById('mpLoadSentinel');
              if (!sentinel) return;
              _mpObserver = new IntersectionObserver(entries => {
                if (entries[0].isIntersecting && !_mpFetching && !_mpExhausted) {
                  mpLoadListings(false);
                }
              }, { rootMargin: '200px' });
              _mpObserver.observe(sentinel);
            }

            // ── Skeleton loading cards (shown while listings fetch) ──
            function mpShowSkeletonCards(n = 6) {
              mpClearSkeletonCards();
              const wrap = document.createElement('div');
              wrap.id = 'mpSkeletonWrap';
              wrap.style.display = 'contents';
              for (let i = 0; i < n; i++) {
                const card = document.createElement('div');
                card.className = 'sr-site sr-skel';
                card.innerHTML = `
                  <div class="sr-site-media"><span class="skel-block"></span></div>
                  <div class="skel-card-body">
                    <span class="skel-block skel-text lg" style="width:80%;"></span>
                    <span class="skel-block skel-text" style="width:100%;"></span>
                    <span class="skel-block skel-text" style="width:60%;"></span>
                    <div class="skel-fins-row">
                      <span class="skel-block"></span><span class="skel-block"></span><span class="skel-block"></span>
                    </div>
                    <div class="skel-footer-row">
                      <span class="skel-block skel-text" style="width:40%;"></span>
                      <span class="skel-block" style="width:64px;height:28px;border-radius:8px;"></span>
                    </div>
                  </div>`;
                wrap.appendChild(card);
              }
              mpGrid.appendChild(wrap);
            }
            function mpClearSkeletonCards() {
              document.getElementById('mpSkeletonWrap')?.remove();
            }
