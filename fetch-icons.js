const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'ItemsData_en.json');
const bannerPath = path.join(__dirname, 'CollectionBanner.json');
const iconsDir = path.join(__dirname, 'icons');

const advDataPath = path.join(__dirname, 'ItemsData_en_advance.json');
const advBannerPath = path.join(__dirname, 'CollectionBanner_advance.json');
const advIconsDir = path.join(__dirname, 'icons_advance');

const ignoreListPath = path.join(__dirname, 'ignore_list.json');
const CONCURRENCY_LIMIT = 150;
const FORCE_UPDATE = false;

const stats = {
    downloaded: 0,
    skipped: 0,
    failed: 0,
    ignoredFull: 0,
    failedItems: []
};

let ignoreData = { ignore_update: [], ignore_all: [] };
if (fs.existsSync(ignoreListPath)) {
    try {
        const rawIgnoreData = fs.readFileSync(ignoreListPath, 'utf8');
        const parsed = JSON.parse(rawIgnoreData);
        if (parsed.ignore_update) ignoreData.ignore_update = parsed.ignore_update.map(String);
        if (parsed.ignore_all) ignoreData.ignore_all = parsed.ignore_all.map(String);
    } catch (error) {
        console.error('Error reading ignore_list.json:', error.message);
    }
}

function ensureIconsDir(dir) {
    if (fs.existsSync(dir)) {
        if (FORCE_UPDATE) {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir);
            console.log(`Cleaned ${path.basename(dir)} folder.`);
        }
    } else {
        fs.mkdirSync(dir, { recursive: true });
    }
}

ensureIconsDir(iconsDir);
ensureIconsDir(advIconsDir);

async function fetchWithRetry(url, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url);
            if (response.status === 404) {
                return response;
            }
            if (response.ok) {
                return response;
            }
        } catch (error) {
            if (i === maxRetries - 1) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return { ok: false };
}

async function downloadIcon(item, targetIconsDir) {
    const itemID = String(item.Id);
    const iconName = item.Icon ? String(item.Icon) : null;

    const isAllIgnored = ignoreData.ignore_all.includes(itemID) || (iconName && ignoreData.ignore_all.includes(iconName));
    const isUpdateIgnored = ignoreData.ignore_update.includes(itemID) || (iconName && ignoreData.ignore_update.includes(iconName));

    if (isAllIgnored) {
        stats.ignoredFull++;
        return;
    }

    let mainIconFound = false;

    const targetId = { id: itemID, file: `${itemID}.png` };
    const pathId = path.join(targetIconsDir, targetId.file);

    if (!FORCE_UPDATE && fs.existsSync(pathId)) {
        stats.skipped++;
        mainIconFound = true;
    } else {
        const url1 = `https://kog-ff-icons.vercel.app/api/icon/${targetId.id}?no_fallback=true`;
        let res1 = await fetchWithRetry(url1);
        if (res1.ok) {
            fs.writeFileSync(pathId, Buffer.from(await res1.arrayBuffer()));
            stats.downloaded++;
            console.log(`Downloaded: ${targetId.file}`);
            mainIconFound = true;
        }
    }

    if (!mainIconFound && iconName) {
        const targetIcon = { id: iconName, file: `${iconName}.png` };
        const pathIcon = path.join(targetIconsDir, targetIcon.file);

        if (!FORCE_UPDATE && fs.existsSync(pathIcon)) {
            stats.skipped++;
            mainIconFound = true;
        } else {
            const urlIcon = `https://kog-ff-icons.vercel.app/api/icon/${targetIcon.id}?no_fallback=true`;
            let resIcon = await fetchWithRetry(urlIcon);
            if (resIcon.ok) {
                fs.writeFileSync(pathIcon, Buffer.from(await resIcon.arrayBuffer()));
                stats.downloaded++;
                console.log(`Downloaded: ${targetIcon.file}`);
                mainIconFound = true;
            }
        }
    }

    if (!mainIconFound) {
        stats.failed++;
        stats.failedItems.push(itemID);
        console.log(`Failed: ${itemID} ${iconName ? '& ' + iconName : ''}`);
    }

    if (!isUpdateIgnored) {
        const targetId2 = { id: `${itemID}_2`, file: `${itemID}_2.png` };
        const pathId2 = path.join(targetIconsDir, targetId2.file);

        if (!FORCE_UPDATE && fs.existsSync(pathId2)) {
            stats.skipped++;
        } else {
            const url2 = `https://kog-ff-icons.vercel.app/api/icon/${targetId2.id}?no_fallback=true`;
            let res2 = await fetchWithRetry(url2);
            if (res2.ok) {
                fs.writeFileSync(pathId2, Buffer.from(await res2.arrayBuffer()));
                stats.downloaded++;
                console.log(`Downloaded: ${targetId2.file}`);
            }
        }
    }
}

async function downloadBanner(bannerItem, targetIconsDir) {
    const iconVal = bannerItem.icon;
    if (!iconVal || String(iconVal).trim() === "") return;

    const iconName = String(iconVal).toLowerCase();

    const isAllIgnored = ignoreData.ignore_all.includes(iconName);

    if (isAllIgnored) {
        stats.ignoredFull++;
        return;
    }

    let mainIconFound = false;
    const targetIcon = { id: iconName, file: `${iconName}.png` };
    const pathIcon = path.join(targetIconsDir, targetIcon.file);

    if (!FORCE_UPDATE && fs.existsSync(pathIcon)) {
        stats.skipped++;
        mainIconFound = true;
    } else {
        const urlIcon = `https://kog-ff-icons.vercel.app/api/icon/${targetIcon.id}?no_fallback=true`;
        let resIcon = await fetchWithRetry(urlIcon);
        if (resIcon.ok) {
            fs.writeFileSync(pathIcon, Buffer.from(await resIcon.arrayBuffer()));
            stats.downloaded++;
            console.log(`Downloaded: ${targetIcon.file}`);
            mainIconFound = true;
        }
    }

    if (!mainIconFound) {
        stats.failed++;
        stats.failedItems.push(`Banner: ${iconName}`);
        console.log(`Failed: Banner ${iconName}`);
    }
}

function writeUpdatedIcons(targetIconsDir, outputFileName) {
    if (!fs.existsSync(targetIconsDir)) return;
    const allFiles = fs.readdirSync(targetIconsDir);
    const updatedIcons = allFiles
        .filter(file => file.endsWith('_2.png'))
        .map(file => file.replace('_2.png', ''))
        .filter(id => !ignoreData.ignore_update.includes(id) && !ignoreData.ignore_all.includes(id));

    fs.writeFileSync(path.join(__dirname, outputFileName), JSON.stringify(updatedIcons));
    return updatedIcons.length;
}

async function start() {
    const tasks = [];

    // ===== LIVE =====
    if (fs.existsSync(dataPath)) {
        const rawData = fs.readFileSync(dataPath, 'utf8');
        const items = JSON.parse(rawData);
        const itemsArray = Array.isArray(items) ? items : Object.values(items);
        const validItems = itemsArray.filter(item => !(item.HideInIndex === true || !item.Icon || String(item.Icon).trim() === ""));

        validItems.forEach(item => {
            tasks.push(() => downloadIcon(item, iconsDir));
        });
    }

    if (fs.existsSync(bannerPath)) {
        const rawBanner = fs.readFileSync(bannerPath, 'utf8');
        const banners = JSON.parse(rawBanner);
        const bannerArray = Array.isArray(banners) ? banners : Object.values(banners);

        bannerArray.forEach(banner => {
            tasks.push(() => downloadBanner(banner, iconsDir));
        });
    }

    // ===== ADVANCE (OB test server) =====
    if (fs.existsSync(advDataPath)) {
        const rawAdvData = fs.readFileSync(advDataPath, 'utf8');
        const advItems = JSON.parse(rawAdvData);
        const advItemsArray = Array.isArray(advItems) ? advItems : Object.values(advItems);
        const validAdvItems = advItemsArray.filter(item => !(item.HideInIndex === true || !item.Icon || String(item.Icon).trim() === ""));

        validAdvItems.forEach(item => {
            tasks.push(() => downloadIcon(item, advIconsDir));
        });
    }

    if (fs.existsSync(advBannerPath)) {
        const rawAdvBanner = fs.readFileSync(advBannerPath, 'utf8');
        const advBanners = JSON.parse(rawAdvBanner);
        const advBannerArray = Array.isArray(advBanners) ? advBanners : Object.values(advBanners);

        advBannerArray.forEach(banner => {
            tasks.push(() => downloadBanner(banner, advIconsDir));
        });
    }

    let currentIndex = 0;

    async function worker() {
        while (currentIndex < tasks.length) {
            const task = tasks[currentIndex++];
            await task();
        }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    const updatedCountLive = writeUpdatedIcons(iconsDir, 'updated_icons.json') || 0;
    const updatedCountAdv = writeUpdatedIcons(advIconsDir, 'updated_icons_advance.json') || 0;

    console.log('\n====================================');
    console.log('         DOWNLOAD SUMMARY           ');
    console.log('====================================');
    console.log(`Total Processed : ${tasks.length}`);
    console.log(`Fully Ignored   : ${stats.ignoredFull}`);
    console.log(`Skipped (Exists): ${stats.skipped}`);
    console.log(`Downloaded New  : ${stats.downloaded}`);
    console.log(`Failed          : ${stats.failed}`);
    console.log(`Updated Icons Detected & Saved (Live)    : ${updatedCountLive}`);
    console.log(`Updated Icons Detected & Saved (Advance) : ${updatedCountAdv}`);

    if (stats.failedItems.length > 0) {
        console.log('------------------------------------');
        console.log('Failed Items IDs / Banners:');
        console.log(stats.failedItems.join(', '));
    }
    console.log('====================================\n');
}

start();
