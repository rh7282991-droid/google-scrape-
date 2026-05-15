chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["leads"], (result) => {
    if (!result.leads) {
      chrome.storage.local.set({ leads: [] });
    }
  });
});
