// State management
let currentTab = 'overview';
let dashboardData = {
    analyze: null,
    health: null,
    cache: null
};

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatNumber(num) {
    return num.toLocaleString();
}

function getHealthClass(score) {
    if (score >= 90) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 50) return 'fair';
    return 'poor';
}

// DOM helper functions
function createElement(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent) el.textContent = textContent;
    return el;
}

function clearContainer(container) {
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
}

// Theme management
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
    const icon = document.querySelector('.theme-icon');
    if (icon) {
        icon.textContent = theme === 'light' ? '🌙' : '☀️';
    }
}

// Tab management
function switchTab(tabName) {
    currentTab = tabName;

    // Update tab buttons
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `tab-${tabName}`);
    });
}

// API calls
async function fetchData() {
    try {
        const [analyzeRes, healthRes, cacheRes] = await Promise.all([
            fetch('/api/analyze').catch(() => null),
            fetch('/api/health').catch(() => null),
            fetch('/api/cache/stats').catch(() => null)
        ]);

        if (analyzeRes && analyzeRes.ok) {
            dashboardData.analyze = await analyzeRes.json();
        }
        if (healthRes && healthRes.ok) {
            dashboardData.health = await healthRes.json();
        }
        if (cacheRes && cacheRes.ok) {
            dashboardData.cache = await cacheRes.json();
        }

        return true;
    } catch (error) {
        console.error('Error fetching data:', error);
        return false;
    }
}

// Rendering functions
function renderOverview() {
    const analyze = dashboardData.analyze;
    if (!analyze) return;

    // Update stats
    document.getElementById('totalPackages').textContent = formatNumber(analyze.totalPackages || 0);
    document.getElementById('totalSize').textContent = formatBytes(analyze.totalSize || 0);
    document.getElementById('maxDepth').textContent = analyze.depth?.maxDepth || '-';

    const healthScore = dashboardData.health?.score || 0;
    document.getElementById('healthScore').textContent = healthScore;

    // Render quick issues
    renderQuickIssues();

    // Render depth chart
    renderDepthChart();
}

function renderQuickIssues() {
    const container = document.getElementById('quickIssues');
    clearContainer(container);

    const analyze = dashboardData.analyze;
    const issues = [];

    if (analyze.duplicates && analyze.duplicates.totalDuplicatePackages > 0) {
        issues.push({
            type: 'warning',
            title: 'Duplicate Packages Detected',
            description: `${analyze.duplicates.totalDuplicatePackages} packages with multiple versions (${formatBytes(analyze.duplicates.totalWastedBytes)} wasted)`
        });
    }

    if (analyze.deprecated && analyze.deprecated.totalDeprecated > 0) {
        issues.push({
            type: 'error',
            title: 'Deprecated Packages Found',
            description: `${analyze.deprecated.totalDeprecated} deprecated packages in use`
        });
    }

    if (analyze.depth && analyze.depth.maxDepth > 10) {
        issues.push({
            type: 'warning',
            title: 'Deep Dependency Tree',
            description: `Maximum depth of ${analyze.depth.maxDepth} may cause resolution issues`
        });
    }

    if (issues.length === 0) {
        container.appendChild(createElement('p', 'empty-state', 'No issues detected'));
        return;
    }

    issues.forEach(issue => {
        const issueDiv = createElement('div', `issue-item ${issue.type}`);
        const titleDiv = createElement('div', 'issue-title', issue.title);
        const descDiv = createElement('div', 'issue-description', issue.description);

        issueDiv.appendChild(titleDiv);
        issueDiv.appendChild(descDiv);
        container.appendChild(issueDiv);
    });
}

function renderDepthChart() {
    const container = document.getElementById('depthChart');
    clearContainer(container);

    const analyze = dashboardData.analyze;

    if (!analyze.depth || !analyze.depth.depthDistribution) {
        container.appendChild(createElement('p', 'empty-state', 'No depth data available'));
        return;
    }

    // Convert Map to array if needed
    const distribution = analyze.depth.depthDistribution instanceof Map
        ? Array.from(analyze.depth.depthDistribution.entries())
        : Object.entries(analyze.depth.depthDistribution);

    if (distribution.length === 0) {
        container.appendChild(createElement('p', 'empty-state', 'No depth data available'));
        return;
    }

    const maxCount = Math.max(...distribution.map(([_, pkgs]) => pkgs.length));

    distribution
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .forEach(([depth, packages]) => {
            const count = packages.length;
            const percentage = (count / maxCount) * 100;

            const barDiv = createElement('div', 'depth-bar');
            const labelDiv = createElement('div', 'depth-label', `Depth ${depth}`);
            const progressDiv = createElement('div', 'depth-progress');
            const fillDiv = createElement('div', 'depth-fill', `${count} packages`);

            fillDiv.style.width = `${percentage}%`;
            progressDiv.appendChild(fillDiv);
            barDiv.appendChild(labelDiv);
            barDiv.appendChild(progressDiv);
            container.appendChild(barDiv);
        });
}

function renderDependencies() {
    renderDuplicates();
    renderDeprecated();
    renderDependencyTree();
}

function renderDuplicates() {
    const container = document.getElementById('duplicatesList');
    clearContainer(container);

    const analyze = dashboardData.analyze;

    if (!analyze.duplicates || analyze.duplicates.duplicates.length === 0) {
        container.appendChild(createElement('p', 'empty-state', 'No duplicates found'));
        return;
    }

    analyze.duplicates.duplicates.forEach(dup => {
        const dupDiv = createElement('div', 'duplicate-item');
        const headerDiv = createElement('div', 'duplicate-header');
        const nameSpan = createElement('span', 'duplicate-name', dup.package);
        const wasteSpan = createElement('span', 'duplicate-waste', `${formatBytes(dup.wastedBytes)} wasted`);

        headerDiv.appendChild(nameSpan);
        headerDiv.appendChild(wasteSpan);
        dupDiv.appendChild(headerDiv);

        const versionsDiv = createElement('div', 'duplicate-versions');
        dup.versions.forEach(v => {
            const isSuggested = v.version === dup.suggestedVersion;
            const badge = createElement('span',
                `version-badge${isSuggested ? ' suggested' : ''}`,
                `${v.version} (${v.count}x)`
            );
            versionsDiv.appendChild(badge);
        });

        dupDiv.appendChild(versionsDiv);
        container.appendChild(dupDiv);
    });
}

function renderDeprecated() {
    const container = document.getElementById('deprecatedList');
    clearContainer(container);

    const analyze = dashboardData.analyze;

    if (!analyze.deprecated || analyze.deprecated.deprecatedPackages.length === 0) {
        container.appendChild(createElement('p', 'empty-state', 'No deprecated packages found'));
        return;
    }

    analyze.deprecated.deprecatedPackages.forEach(pkg => {
        const pkgDiv = createElement('div', 'deprecated-item');
        const headerDiv = createElement('div', 'deprecated-header', `${pkg.name}@${pkg.version}`);
        const messageDiv = createElement('div', 'deprecated-message', pkg.deprecationMessage);
        const dependentsDiv = createElement('div', 'deprecated-dependents',
            `Used by: ${pkg.dependedOnBy.join(', ')}`
        );

        pkgDiv.appendChild(headerDiv);
        pkgDiv.appendChild(messageDiv);
        pkgDiv.appendChild(dependentsDiv);
        container.appendChild(pkgDiv);
    });
}

function renderDependencyTree() {
    const container = document.getElementById('dependencyTree');
    clearContainer(container);

    const analyze = dashboardData.analyze;

    if (!analyze.graph || !analyze.graph.root) {
        container.appendChild(createElement('p', 'empty-state', 'No dependency data available'));
        return;
    }

    const root = analyze.graph.root;
    const packages = analyze.graph.packages;

    const rootNode = createElement('div', 'tree-node direct', `${root.name}@${root.version}`);
    container.appendChild(rootNode);

    // Render direct dependencies
    if (root.dependencies && root.dependencies.length > 0) {
        const directDeps = root.dependencies.slice(0, 50); // Limit to first 50 for performance

        directDeps.forEach(depId => {
            const pkg = packages[depId] || packages.get?.(depId);
            if (pkg) {
                const depNode = createElement('div', 'tree-node');
                const indent = createElement('span', 'tree-indent', '└─');
                depNode.appendChild(indent);
                depNode.appendChild(document.createTextNode(` ${pkg.name}@${pkg.version}`));
                container.appendChild(depNode);

                // Show first level of transitive deps (limited)
                if (pkg.dependencies && pkg.dependencies.length > 0) {
                    const transitiveDeps = pkg.dependencies.slice(0, 3);
                    transitiveDeps.forEach(transDepId => {
                        const transPkg = packages[transDepId] || packages.get?.(transDepId);
                        if (transPkg) {
                            const transNode = createElement('div', 'tree-node');
                            transNode.appendChild(createElement('span', 'tree-indent', '  '));
                            transNode.appendChild(createElement('span', 'tree-indent', '└─'));
                            transNode.appendChild(document.createTextNode(` ${transPkg.name}@${transPkg.version}`));
                            container.appendChild(transNode);
                        }
                    });
                    if (pkg.dependencies.length > 3) {
                        const moreNode = createElement('div', 'tree-node');
                        moreNode.appendChild(createElement('span', 'tree-indent', '  '));
                        moreNode.appendChild(createElement('span', 'tree-indent', '  '));
                        moreNode.appendChild(document.createTextNode(`... ${pkg.dependencies.length - 3} more`));
                        container.appendChild(moreNode);
                    }
                }
            }
        });

        if (root.dependencies.length > 50) {
            container.appendChild(createElement('div', 'tree-node',
                `... ${root.dependencies.length - 50} more packages`
            ));
        }
    }
}

function renderHealth() {
    const health = dashboardData.health;

    if (!health) {
        const container = document.getElementById('healthBreakdown');
        clearContainer(container);
        container.appendChild(createElement('p', 'empty-state', 'No health data available'));
        return;
    }

    const score = health.score || 0;
    const healthClass = getHealthClass(score);

    // Update health score circle
    const scoreCircle = document.getElementById('healthScoreCircle');
    const scoreValue = document.getElementById('healthScoreValue');

    scoreCircle.className = `health-score-circle ${healthClass}`;
    scoreCircle.style.setProperty('--score-angle', score * 3.6);
    scoreValue.textContent = score;

    // Render health breakdown
    renderHealthBreakdown(health);

    // Render recommendations
    renderRecommendations(health);
}

function renderHealthBreakdown(health) {
    const container = document.getElementById('healthBreakdown');
    clearContainer(container);

    const metrics = [
        { name: 'Duplicate Impact', value: health.duplicateScore || 100 },
        { name: 'Deprecation Impact', value: health.deprecationScore || 100 },
        { name: 'Depth Impact', value: health.depthScore || 100 },
        { name: 'Size Efficiency', value: health.sizeScore || 100 }
    ];

    metrics.forEach(metric => {
        const metricDiv = createElement('div', 'health-metric');
        const nameSpan = createElement('span', 'health-metric-name', metric.name);
        const valueSpan = createElement('span',
            `health-metric-value ${getHealthClass(metric.value)}`,
            String(metric.value)
        );

        metricDiv.appendChild(nameSpan);
        metricDiv.appendChild(valueSpan);
        container.appendChild(metricDiv);
    });
}

function renderRecommendations(health) {
    const container = document.getElementById('recommendations');
    clearContainer(container);

    const recommendations = [];

    if (health.duplicateScore < 80) {
        recommendations.push({
            title: 'Resolve Duplicate Packages',
            description: 'Use package manager deduplication or update lock files to consolidate duplicate packages.'
        });
    }

    if (health.deprecationScore < 80) {
        recommendations.push({
            title: 'Update Deprecated Packages',
            description: 'Replace deprecated packages with maintained alternatives to ensure security and compatibility.'
        });
    }

    if (health.depthScore < 80) {
        recommendations.push({
            title: 'Flatten Dependency Tree',
            description: 'Consider using package manager hoisting or reviewing direct dependencies to reduce tree depth.'
        });
    }

    if (recommendations.length === 0) {
        container.appendChild(createElement('p', 'empty-state',
            'No recommendations - your dependencies look healthy!'
        ));
        return;
    }

    recommendations.forEach(rec => {
        const recDiv = createElement('div', 'recommendation-item');
        const titleDiv = createElement('div', 'recommendation-title', rec.title);
        const descDiv = createElement('div', 'recommendation-description', rec.description);

        recDiv.appendChild(titleDiv);
        recDiv.appendChild(descDiv);
        container.appendChild(recDiv);
    });
}

function renderCache() {
    const cache = dashboardData.cache;

    if (!cache) {
        const container = document.getElementById('cacheStats');
        clearContainer(container);
        container.appendChild(createElement('p', 'empty-state', 'No cache data available'));
        return;
    }

    // Update cache stats cards
    document.getElementById('cacheSize').textContent = formatBytes(cache.totalSize || 0);
    document.getElementById('cachedPackages').textContent = formatNumber(cache.packageCount || 0);

    const hitRate = cache.hits && cache.total
        ? Math.round((cache.hits / cache.total) * 100)
        : 0;
    document.getElementById('cacheHitRate').textContent = `${hitRate}%`;

    // Render detailed cache stats
    renderCacheStats(cache);
}

function renderCacheStats(cache) {
    const container = document.getElementById('cacheStats');
    clearContainer(container);

    const stats = [
        { label: 'Total Entries', value: formatNumber(cache.packageCount || 0) },
        { label: 'Cache Hits', value: formatNumber(cache.hits || 0) },
        { label: 'Cache Misses', value: formatNumber(cache.misses || 0) },
        { label: 'Total Size', value: formatBytes(cache.totalSize || 0) },
        { label: 'Average Package Size', value: formatBytes(cache.averageSize || 0) },
        { label: 'Last Updated', value: cache.lastUpdated || 'Never' }
    ];

    stats.forEach(stat => {
        const statDiv = createElement('div', 'cache-stat-row');
        const labelSpan = createElement('span', 'cache-stat-label', stat.label);
        const valueSpan = createElement('span', 'cache-stat-value', stat.value);

        statDiv.appendChild(labelSpan);
        statDiv.appendChild(valueSpan);
        container.appendChild(statDiv);
    });
}

function renderAll() {
    renderOverview();
    renderDependencies();
    renderHealth();
    renderCache();
}

function showError(message) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('content').classList.add('hidden');
    document.getElementById('error').classList.remove('hidden');
    document.getElementById('errorMessage').textContent = message;
}

function showContent() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('error').classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');
}

// Initialize app
async function init() {
    initTheme();

    // Set up event listeners
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            switchTab(e.target.dataset.tab);
        });
    });

    // Fetch data
    const success = await fetchData();

    if (!success || !dashboardData.analyze) {
        showError('Failed to load dashboard data. Make sure the Better CLI server is running.');
        return;
    }

    // Render all sections
    renderAll();
    showContent();
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
