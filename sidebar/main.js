class GroupList {
  constructor() {
    this.groups = [];
    this._tabCache = new Map();
    this._activeTab = null;
    this._container = document.getElementById("container");
    this.windowId = null;
    this._contextMenu = null;
    this._signalBatchMove = false;

    this._searchBar = document.getElementById("search");
    this._cancelButton = document.getElementById("cancel-search-icon");

    document.getElementById("new-group-button").addEventListener("click", () => {
      this.addGroup(new Group("untitled"));
    });

    this._searchBar.addEventListener("keyup", (e) => {
      if(e.key === "Escape" || e.key === "Esc") {
        this._searchBar.value = "";
        this._cancelButton.classList.add("hidden");
        this._searchBar.blur();
        this.displayAll();
        return;
      }

      this._cancelButton.classList.toggle("hidden", !this._searchBar.value);
      this._searchBar.value ? this.filterFromText(this._searchBar.value) : this.displayAll();
    });

    this._cancelButton.addEventListener("click", () => {
      this._cancelButton.classList.add("hidden");
      this._searchBar.value = "";
      this.displayAll();
    });

    this.populate();

    // event registration for tab syncing
    browser.tabs.onActivated.addListener((info) => this.onActivated(info));
    browser.tabs.onCreated.addListener((info) => this.onCreated(info));
    browser.tabs.onRemoved.addListener((tabId, info) => this.onRemoved(tabId, info));
    browser.tabs.onDetached.addListener((tabId, info) => this.onDetached(tabId, info));
    browser.tabs.onAttached.addListener((tabId, info) => this.onAttached(tabId, info));
    browser.tabs.onUpdated.addListener((tabId, changeInfo, info) => this.onUpdated(tabId, changeInfo, info));
    browser.tabs.onMoved.addListener((tabId, moveInfo) => this.onMoved(tabId, moveInfo));

    this._container.addEventListener("dragover", (e) => {
      let data = e.dataTransfer.getData("tab-data-type");
      if(!data || data !== "group") {
        return;
      }

      this._container.classList.add("group-drag-target");
      e.preventDefault();
    });

    this._container.addEventListener("dragleave", (e) => {
      this._container.classList.remove("group-drag-target");
    });

    this._container.addEventListener("drop", (e) => this.onDrop(e));
    this._container.addEventListener("contextmenu", (e) => this.onContextMenu(e));

    window.addEventListener("click", (e) => this.hideContextMenu());
    window.addEventListener("blur", (e) => this.hideContextMenu());
    window.addEventListener("keyup", (e) => {
      if(e.key === "Escape") {
        this.hideContextMenu();
      }
    });
  }

  async populate() {
    let windowInfo = await browser.windows.getCurrent({populate: true});
    this.windowId = windowInfo.id;

    let old = await browser.storage.local.get("groups");
    if(!old.hasOwnProperty("groups")) {
      // no pre-existing group so just make a dummy one
      // and fill it with the current tab data
      let group = new Group("untitled");
      for(let tab of windowInfo.tabs) {
        let entry = new TabEntry(tab);
        if(tab.active) {
          this._activeTab = entry;
        }

        this._tabCache.set(tab.id, entry);
        group.addTab(entry);
      }

      this.addGroup(group);
    }
    else {
      // load our groups from localStorage
      await this.loadFromLocalStorage(old.groups, windowInfo.tabs);
    }

    if(this._activeTab) {
      this._activeTab.toggleActive(true); // scroll
    }
  }

  async loadFromLocalStorage(groups, tabs) {
    // fast lookup
    let lookup = new Map();

    for(let data of groups) {
      let group = new Group(data);
      group.parent = this;
      this.groups.push(group);
      lookup.set(group.uuid, group);
    }

    let oldActiveGroup = this.groups.find((g) => g.active);

    for(let tab of tabs) {
      let entry = new TabEntry(tab);
      if(tab.active) {
        this._activeTab = entry;
      }

      this._tabCache.set(tab.id, entry);

      // get the group associated with the tab
      let groupId = await browser.sessions.getTabValue(tab.id, "group-id");
      if(groupId) {
        let group = lookup.get(groupId, null);
        if(group) {
          group.loadTab(entry);
        }
        else {
          console.log(`group ${groupId} is not found`);
        }
      }
      else {
        // a tab with no group ID in its session is a "ghost" tab
        // which means we have to assign it to the last active group
        if(oldActiveGroup) {
          oldActiveGroup.addTab(entry);
        }
      }
    }

    // sort the groups and add to the container
    for(let group of this.groups) {
      group.sortByPosition();
      this._container.appendChild(group.view);
    }
  }

  async resync() {
    let tabs = await browser.tabs.query({windowId: this.windowId});
    for(var tab of tabs) {
      let entry = this.getTab(tab.id);
      entry.update(tab);
    }
  }

  addGroup(group) {
    group.parent = this;
    this.groups.push(group);
    this._container.appendChild(group.view);
    this.saveStorage();
  }

  displayAll() {
    for(let tab of this._tabCache.values()) {
      tab.show();
    }
  }

  getTab(tabId) {
    return this._tabCache.get(tabId, null);
  }

  getGroup(groupId) {
    let group = this.groups.find((g) => g.uuid == groupId);
    if(group === undefined) {
      return null;
    }
    return group;
  }

  removeGroup(group) {
    let index = this.groups.indexOf(group);
    if(index == -1) {
      // kind of strange
      return;
    }

    for(let tab of group.tabs) {
      tab.close();
    }

    this._container.removeChild(group.view);
    this.groups.splice(index, 1);
    this.saveStorage();
  }

  get activeGroup() {
    return this._activeTab && this._activeTab.group;
  }

  get groupCount() {
    return this.groups.length;
  }

  filterFromText(substring) {
    for(let tab of this._tabCache.values()) {
      let match = tab.matchesTitle(substring);
      tab.toggleVisibility(match);
    }
  }

  createTab(opts) {
    let group = opts.group || this.activeGroup;
    let active = opts.active || true;
    browser.tabs.create({active: active}).then((tabInfo) => {
      // this function takes priority over the onCreated function
      // So let's do this after the current "tick" of the event loop
      setTimeout(() => {
        let oldEntry = this.getTab(tabInfo.id);
        if(oldEntry.group !== group) {
          oldEntry.detach();
        }
        group.addTab(oldEntry);
      }, 0);
    });
  }

  beginBatchMove() {
    this._signalBatchMove = true;
  }

  endBatchMove() {
    this._signalBatchMove = false;
  }

  toJSON() {
    return {
      groups: this.groups.map((group) => group.toJSON())
    };
  }

  saveStorage() {
    browser.storage.local.set(this.toJSON());
  }

  hideContextMenu() {
    if(this._contextMenu) {
      this._contextMenu.hide();
      this._contextMenu = null;
    }
  }

  onContextMenu(e) {
    this.hideContextMenu();
    e.preventDefault();

    let tabId = TabEntry.tabIdFromEvent(e);
    let items = [];
    if(tabId !== null) {
      let tab = this.getTab(tabId);
      if(!tab) {
        return;
      }
      items = tab.getContextMenuItems(this);
    }
    else {
      let groupId = Group.groupIdFromEvent(e);
      if(groupId === null) {
        return;
      }
      let group = this.getGroup(groupId);
      if(!group) {
        return;
      }
      items = group.getContextMenuItems(this);
    }

    this._contextMenu = new ContextMenu(e, items);
    this._contextMenu.show();
  }

  onActivated(info) {
    console.log(`onActivated: ${this.windowId}/${info.tabId} -> ${JSON.stringify(info)}`);
    if(info.windowId !== this.windowId) {
      return;
    }

    this.setActive(this.getTab(info.tabId));
    this.saveStorage();
  }

  onMoved(tabId, moveInfo) {
    console.log(`${this.windowId}/${tabId} -> ${JSON.stringify(moveInfo)}`);
    if(moveInfo.windowId !== this.windowId || this._signalBatchMove) {
      return;
    }

    let tab = this.getTab(tabId);
    if(!tab || !tab.group) {
      return;
    }

    /*
      - Swap positions
      - Increment index for toIndex to fromIndex-1 if fromIndex > toIndex
        - If toIndex > fromIndex then subtract index by 1 instead
    */

    tab.group.repositionTab(tabId, moveInfo.toIndex);
    let min, max, increment;
    if(moveInfo.toIndex > moveInfo.fromIndex) {
      increment = -1;
      min = moveInfo.fromIndex;
      max = moveInfo.toIndex + 1;
    }
    else {
      increment = 1;
      min = moveInfo.toIndex;
      max = moveInfo.fromIndex;
    }

    for(var entry of this._tabCache.values()) {
      if(entry.index >= min && entry.index < max) {
        entry.index += increment;
      }
    }

    tab.index = moveInfo.toIndex;
  }

  setActive(tab) {
    if(this._activeTab) {
      this._activeTab.toggleActive(false);
    }

    if(tab) {
      tab.toggleActive(true);
      this._activeTab = tab;
    }
  }

  scrollToActiveTab() {
    if(this._activeTab) {
      this._activeTab.scrollTo();
    }
  }

  onCreated(tabInfo) {
    console.log(`onCreated: ${this.windowId}/${tabInfo.id}`);
    // check if this tab was already created and has a group
    let oldEntry = this.getTab(tabInfo.id);
    if(oldEntry && oldEntry.group) {
      return;
    }

    // update the positions of the tabs
    for(var tab of this._tabCache.values()) {
      if(tab.index >= tabInfo.index) {
        tab.index += 1;
      }
    }

    let entry = new TabEntry(tabInfo);
    this._tabCache.set(tabInfo.id, entry);

    if(this._searchBar.value) {
      entry.toggleVisibility(entry.matchesTitle(this._searchBar.value));
    }

    let openerTab = tabInfo.hasOwnProperty("openerTabId") ? this.getTab(tabInfo.openerTabId) : null;
    let group = this.activeGroup;
    if(group) {
      group.addTab(entry, openerTab);
    }
  }

  _removeTab(tabId) {
    let tab = this.getTab(tabId);
    if(tab) {
      tab.detach();
    }
    this._tabCache.delete(tabId);

    // update positions
    console.log("Okay...");
    for(var entry of this._tabCache.values()) {
      if(entry.index >= tab.index) {
        entry.index -= 1;
      }
    }
  }

  onRemoved(tabId, removeInfo) {
    console.log(`onRemoved: ${this.windowId}/${tabId}`);
    this._removeTab(tabId);
  }

  onDetached(tabId, detachInfo) {
    console.log(`onDetached: ${this.windowId}/${tabId} -> ${JSON.stringify(detachInfo)}`);
    this._removeTab(tabId);
  }

  async onAttached(tabId, attachInfo) {
    console.log(`onAttached: ${this.windowId}/${tabId} -> ${JSON.stringify(attachInfo)}`);
    if(attachInfo.newWindowId !== this.windowId) {
      return;
    }

    let tabInfo = await browser.tabs.get(tabId);
    tabInfo.id = tabId;
    let entry = new TabEntry(tabInfo);
    this._tabCache.set(tabInfo.id, entry);
    let group = this.activeGroup;

    if(entry.active) {
      this.setActive(entry);
    }

    if(group) {
      group.attachTab(entry, attachInfo.newPosition);
    }
  }

  onUpdated(tabId, changeInfo, tabInfo) {
    console.log(`onUpdated: ${this.windowId}/${tabId} -> ${JSON.stringify(changeInfo)} -> ${JSON.stringify(tabInfo)}`);
    let tab = this.getTab(tabId);
    if(tab) {
      tab.update(changeInfo);
      if(this._searchBar.value) {
        tab.toggleVisibility(tab.matchesTitle(this._searchBar.value));
      }
    }
  }

  onDrop(e) {
    let data = JSON.parse(e.dataTransfer.getData("tab-data"));
    if(!data) {
      return;
    }

    let groupIndex = this.groups.findIndex((g) => g.uuid == data.id);
    if(groupIndex === -1) {
      return;
    }

    let group = this.groups[groupIndex];

    // get the closest detail tag
    let el = e.target.closest("[data-group-id]");
    let beforeGroupId = el.getAttribute("data-group-id");
    if(beforeGroupId === data.id) {
      return;
    }

    let targetIndex = this.groups.findIndex((g) => g.uuid == beforeGroupId);

    // remove the group from the array and reinsert it at an appropriate position
    this.groups.splice(targetIndex, 0, this.groups.splice(groupIndex, 1)[0]);

    // modify the DOM to point to the new structure
    if(groupIndex > targetIndex) {
      this._container.insertBefore(group.view, el);
    }
    else {
      this._container.insertBefore(group.view, el.nextSibling);
    }

    this._container.classList.remove("group-drag-target");
    e.preventDefault();
    this.saveStorage();
  }
}


var groupList = new GroupList();

async function verifyCache() {
  let actualTabs = await browser.tabs.query({currentWindow: true});
  let failed = 0;
  for(var tab of actualTabs) {
    let cached = groupList.getTab(tab.id);
    if(cached.index !== tab.index) {
      console.log(`Incorrect index for ${tab.id} (${tab.index} vs cached ${cached.index})`);
      ++failed;
    }
  }
  console.log(`${failed} failures`);
}

function debugGroup(index) {
  let g = groupList.groups[index];
  for(var t of g.tabs) {
    console.log(`${t.id} -> ${t.title}`);
  }
}

function checkTabs(...tabIds) {
  for(var tabId of tabIds) {
    let tab = groupList.getTab(tabId);
    console.log(`${tab.id} -> ${tab.title}`);
  }
}
