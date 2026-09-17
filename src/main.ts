import * as THREE from 'three';
import './style.css';
import type { InventoryItem, ActivityLog, RequestRecord, BorrowRecord } from './types';

// Global declarations for CDN libraries
declare const lucide: {
    createIcons: (options?: any) => void;
};

// Safe, idempotent Lucide icon renderer that NEVER destroys already-rendered SVGs
function renderLucideIcons(root?: HTMLElement | Document | null) {
    const rawCreateIcons = (window as any).__rawLucideCreateIcons || (typeof lucide !== 'undefined' ? lucide.createIcons : null);
    if (!rawCreateIcons) return;
    const target = root || document;

    // Only select elements that need icon creation (not already rendered SVGs)
    const placeholders = target.querySelectorAll('i[data-lucide], span[data-lucide], [data-lucide]:not(svg)');
    if (placeholders.length === 0) return;

    try {
        rawCreateIcons({
            root: target instanceof HTMLElement ? target : undefined
        });
    } catch {
        try { rawCreateIcons(); } catch {}
    }

    // Strip data-lucide from rendered SVGs to prevent future calls from destroying/re-rendering them
    const renderedSvgs = target.querySelectorAll('svg[data-lucide]');
    renderedSvgs.forEach(svg => {
        svg.removeAttribute('data-lucide');
        svg.setAttribute('data-lucide-rendered', 'true');
    });
}

// Intercept lucide.createIcons globally so ANY third-party or legacy call is automatically safe
if (typeof window !== 'undefined') {
    const installLucideGuard = () => {
        if (typeof lucide !== 'undefined' && lucide.createIcons && !(window as any).__rawLucideCreateIcons) {
            (window as any).__rawLucideCreateIcons = lucide.createIcons.bind(lucide);
            lucide.createIcons = (options?: any) => {
                const root = options && options.root ? options.root : undefined;
                renderLucideIcons(root);
            };
        }
    };
    installLucideGuard();
    window.addEventListener('DOMContentLoaded', installLucideGuard);
}

// Dynamic API URL for Local Development & Live Production
const isLocalHost = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname.startsWith('192.168.') ||
    window.location.hostname.startsWith('10.') ||
    window.location.hostname.endsWith('.local')
);

let API_BASE = (import.meta.env.VITE_API_BASE as string) ||
    (isLocalHost
        ? `http://${(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'localhost' : window.location.hostname}:5000/api`
        : 'https://cicr-inventory-backend.onrender.com/api');

const CLOUD_API_FALLBACK = 'https://cicr-inventory-backend.onrender.com/api';

// Intelligent Automatic Failover: If local backend request fails, fall back for that request without permanently poisoning API_BASE
if (typeof window !== 'undefined' && window.fetch) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        try {
            return await originalFetch(input, init);
        } catch (err: any) {
            const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
            if (urlStr && (urlStr.includes(':5000/api'))) {
                const fallbackUrl = urlStr.replace(/https?:\/\/[^/]+:5000\/api/, CLOUD_API_FALLBACK);
                console.warn(`[CICR API] Local backend unreachable. Auto-falling back to cloud backend: ${fallbackUrl}`);
                return originalFetch(fallbackUrl, init);
            }
            throw err;
        }
    };
}

const ADMIN_USERNAME = 'SRVKILLER09';

type UserRole = 'ADMIN' | 'MEMBER';

// Top-level global binding for self-service password reset modal
(window as any).openPasswordResetModal = () => {
    const modal = document.getElementById('reset-password-modal');
    if (modal) modal.classList.add('active');
    if (typeof PasswordResetManager !== 'undefined') {
        PasswordResetManager.open();
    }
};

// Global state variables
let inventory: InventoryItem[] = [];
let logs: ActivityLog[] = [];
let requests: RequestRecord[] = [];
let selectedItem: InventoryItem | null = null;

/**
 * Resolves component stock status per specification:
 * - If total <= 1 (quantity = 1):
 *     available > 0  => "Available" (status-available)
 *     available <= 0 => "Not Available" (status-out)
 * - If total > 1:
 *     available <= 0 => "Not Available" (status-out)
 *     available > total / 2 => "Available" (status-available)
 *     available <= total / 2 => "Low Reserve" (status-low)
 */
function getItemStockStatus(totalQty: number, availableQty: number): {
    text: string;
    class: 'status-available' | 'status-low' | 'status-out';
} {
    const total = Number(totalQty) || 0;
    const available = Number(availableQty) || 0;

    if (total <= 1) {
        if (available > 0) {
            return { text: 'Available', class: 'status-available' };
        }
        return { text: 'Not Available', class: 'status-out' };
    }

    if (available <= 0) {
        return { text: 'Not Available', class: 'status-out' };
    }
    if (available > total / 2) {
        return { text: 'Available', class: 'status-available' };
    }
    return { text: 'Low Reserve', class: 'status-low' };
}

// ==========================================
// 1.5. Real-Time Floating Cyber Toast Notifications
// ==========================================
class ToastManager {
    private static container: HTMLElement | null = null;

    static init() {
        if (!this.container) {
            this.container = document.getElementById('toast-container');
            if (!this.container) {
                this.container = document.createElement('div');
                this.container.id = 'toast-container';
                document.body.appendChild(this.container);
            }
        }
    }

    static show(title: string, desc: string, type: 'success' | 'info' | 'warning' | 'error' = 'info') {
        this.init();
        if (!this.container) return;

        const toast = document.createElement('div');
        toast.className = `cyber-toast toast-${type}`;

        const iconName = type === 'success' ? 'check-circle'
            : type === 'warning' ? 'alert-triangle'
                : type === 'error' ? 'alert-octagon' : 'bell';

        toast.innerHTML = `
            <div class="toast-icon-wrap">
                <i data-lucide="${iconName}"></i>
            </div>
            <div class="toast-content-wrap">
                <h4 class="toast-title">${title}</h4>
                <p class="toast-desc">${desc}</p>
            </div>
            <button class="toast-close-btn" title="Dismiss">
                <i data-lucide="x" style="width:14px;height:14px;"></i>
            </button>
        `;

        toast.querySelector('.toast-close-btn')!.addEventListener('click', () => {
            toast.classList.remove('show');
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 350);
        });

        this.container.appendChild(toast);
        renderLucideIcons(toast);

        requestAnimationFrame(() => {
            setTimeout(() => toast.classList.add('show'), 20);
        });

        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.remove('show');
                toast.classList.add('hide');
                setTimeout(() => toast.remove(), 350);
            }
        }, 4200);
    }

    static showWelcome(userName: string, role: string = 'MEMBER') {
        this.init();
        if (!this.container) return;

        const displayRole = (role || 'MEMBER').toUpperCase();
        const initial = (userName.trim().charAt(0) || 'U').toUpperCase();

        const toast = document.createElement('div');
        toast.className = 'cyber-toast toast-welcome';

        toast.innerHTML = `
            <div class="welcome-toast-glow"></div>
            <div class="welcome-avatar-wrap">
                <span class="welcome-avatar-letter">${initial}</span>
                <span class="welcome-status-dot"></span>
            </div>
            <div class="welcome-body">
                <div class="welcome-top-meta">
                    <span class="welcome-badge">
                        <i data-lucide="shield-check"></i> AUTHENTICATED
                    </span>
                    <span class="welcome-role-pill ${displayRole.toLowerCase()}">${displayRole}</span>
                </div>
                <div class="welcome-headline">
                    Welcome, <span class="welcome-highlight-name">${userName}</span>
                </div>
                <div class="welcome-subtext">
                    Access granted to CICR Robotics Inventory
                </div>
            </div>
            <button class="toast-close-btn" title="Dismiss">
                <i data-lucide="x" style="width:14px;height:14px;"></i>
            </button>
            <div class="welcome-progress-track">
                <div class="welcome-progress-fill"></div>
            </div>
        `;

        toast.querySelector('.toast-close-btn')!.addEventListener('click', () => {
            toast.classList.remove('show');
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 350);
        });

        this.container.appendChild(toast);
        renderLucideIcons(toast);

        requestAnimationFrame(() => {
            setTimeout(() => toast.classList.add('show'), 20);
        });

        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.remove('show');
                toast.classList.add('hide');
                setTimeout(() => toast.remove(), 350);
            }
        }, 5500);
    }
}

// ==========================================
// 2. Three.js 3D Background Engine
// ==========================================
class Background3D {
    private canvas: HTMLCanvasElement;
    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;

    private particles!: THREE.Points;
    private particlePhases: Float32Array = new Float32Array(0);
    private currentTheme = 'cyberpunk';

    private mouseX = 0;
    private mouseY = 0;
    private targetCameraX = 0;
    private targetCameraY = 4;

    constructor() {
        this.canvas = document.getElementById('canvas-3d') as HTMLCanvasElement;
        if (!this.canvas) return;
        this.init();
        this.createLighting();
        this.createParticles();
        this.setupEvents();
        this.animate();
    }

    private init() {
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x06060e, 0.015);

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 4, 18);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }

    private createLighting() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        const pointLight = new THREE.PointLight(0xbd00ff, 1.5, 100);
        pointLight.position.set(0, 10, -20);
        this.scene.add(pointLight);

        const pointLight2 = new THREE.PointLight(0x00f0ff, 1.5, 100);
        pointLight2.position.set(20, 5, 10);
        this.scene.add(pointLight2);
    }

    public updateThemeColors(theme: string) {
        this.currentTheme = theme;
        let fogHex = 0x06060e;
        if (theme === 'light') fogHex = 0xf1f5f9;
        else if (theme === 'sakura' || theme === 'pink') fogHex = 0xfce2ed;

        if (this.canvas) {
            if (theme === 'sakura' || theme === 'pink' || theme === 'light') {
                this.canvas.style.opacity = '0.04';
            } else {
                this.canvas.style.opacity = '1';
            }
        }

        if (this.scene) {
            this.scene.fog = new THREE.FogExp2(fogHex, (theme === 'sakura' || theme === 'pink') ? 0.01 : 0.015);
        }

        this.setParticleColorsForTheme(theme);
    }

    private setParticleColorsForTheme(theme: string) {
        if (!this.particles) return;
        const colors = this.particles.geometry.attributes.color.array as Float32Array;
        const count = colors.length / 3;

        let color1 = new THREE.Color(0x00f0ff);
        let color2 = new THREE.Color(0xbd00ff);
        let color3 = new THREE.Color(0xff007a);

        if (theme === 'sakura' || theme === 'pink') {
            color1 = new THREE.Color(0xec4899); // Sakura Blossom Pink
            color2 = new THREE.Color(0xf43f5e); // Rose Petal Crimson
            color3 = new THREE.Color(0xf472b6); // Soft Blossom Rose
        } else if (theme === 'light') {
            color1 = new THREE.Color(0x0284c7);
            color2 = new THREE.Color(0x7c3aed);
            color3 = new THREE.Color(0xdb2777);
        }

        for (let i = 0; i < count; i++) {
            const rand = Math.random();
            let c = color1;
            if (rand > 0.6) c = color2;
            else if (rand > 0.3) c = color3;

            colors[i * 3] = c.r;
            colors[i * 3 + 1] = c.g;
            colors[i * 3 + 2] = c.b;
        }

        this.particles.geometry.attributes.color.needsUpdate = true;
    }

    private createParticles() {
        const particleCount = 350;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);
        this.particlePhases = new Float32Array(particleCount);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 120;
            positions[i * 3 + 1] = Math.random() * 40 - 10;
            positions[i * 3 + 2] = (Math.random() - 0.7) * 150;
            this.particlePhases[i] = Math.random() * Math.PI * 2;
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const material = new THREE.PointsMaterial({
            size: 0.24,
            vertexColors: true,
            transparent: true,
            opacity: 0.88,
            blending: THREE.AdditiveBlending
        });

        this.particles = new THREE.Points(geometry, material);
        this.scene.add(this.particles);
        this.setParticleColorsForTheme(this.currentTheme);
    }

    private setupEvents() {
        window.addEventListener('mousemove', (e) => {
            this.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
        });

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        });
    }

    private animate() {
        requestAnimationFrame(() => this.animate());

        if (this.particles) {
            const positions = this.particles.geometry.attributes.position.array as Float32Array;
            const particleCount = positions.length / 3;
            const time = Date.now() * 0.001;

            for (let i = 0; i < particleCount; i++) {
                if (this.currentTheme === 'sakura') {
                    // Gentle falling & swaying Sakura Cherry Blossom petals
                    positions[i * 3 + 1] -= 0.035;
                    positions[i * 3] += Math.sin(time * 1.5 + this.particlePhases[i]) * 0.025;
                    positions[i * 3 + 2] += Math.cos(time * 1.0 + this.particlePhases[i]) * 0.015;

                    if (positions[i * 3 + 1] < -10) {
                        positions[i * 3 + 1] = 30;
                        positions[i * 3] = (Math.random() - 0.5) * 120;
                    }
                } else {
                    positions[i * 3 + 1] += 0.015;
                    positions[i * 3 + 2] += 0.03;

                    if (positions[i * 3 + 1] > 30) {
                        positions[i * 3 + 1] = -5;
                    }
                    if (positions[i * 3 + 2] > 20) {
                        positions[i * 3 + 2] = -120;
                        positions[i * 3] = (Math.random() - 0.5) * 120;
                    }
                }
            }
            this.particles.geometry.attributes.position.needsUpdate = true;
        }

        this.targetCameraX = this.mouseX * 3;
        this.targetCameraY = 4 + (this.mouseY * 1.5);

        this.camera.position.x += (this.targetCameraX - this.camera.position.x) * 0.05;
        this.camera.position.y += (this.targetCameraY - this.camera.position.y) * 0.05;

        this.camera.lookAt(0, -1, -5);

        this.renderer.render(this.scene, this.camera);
    }
}

// ==========================================
// 3. Database Manager & Supabase Realtime Auto-Sync
// ==========================================
class DatabaseManager {
    static init() {
        const storedInventory = localStorage.getItem('cicr_inventory');
        if (storedInventory) {
            try {
                inventory = JSON.parse(storedInventory);
                inventory.forEach((item: any) => {
                    const nm = (item.name || '').toLowerCase();
                    if (nm.includes('model unclear') || nm === 'arduino board') {
                        item.name = 'Arduino Uno R3';
                    }
                });
            } catch {
                inventory = [];
            }
        } else {
            inventory = [];
        }

        const storedLogs = localStorage.getItem('cicr_logs');
        if (storedLogs) {
            try {
                logs = JSON.parse(storedLogs);
            } catch {
                logs = [];
            }
        } else {
            logs = [];
        }

        const storedRequests = localStorage.getItem('cicr_requests');
        if (storedRequests) {
            try {
                const parsed = JSON.parse(storedRequests);
                // Purge any stale mock/test records (e.g. purpose containing "Testing" or "Robo Soccer", or stale test ID)
                requests = (parsed || []).filter((r: any) =>
                    r && r.purpose &&
                    r.id !== 'req_1789341756703_7d6b6494' &&
                    !r.purpose.toLowerCase().includes('testing') &&
                    !r.purpose.toLowerCase().includes('robo soccer')
                );
                localStorage.setItem('cicr_requests', JSON.stringify(requests));
            } catch {
                requests = [];
                localStorage.removeItem('cicr_requests');
            }
        } else {
            requests = [];
        }

        // Immediately auto-sync with Supabase backend without delay
        this.syncFromBackend();
        this.updateNotificationBadges();
    }

    static async syncFromBackend() {
        try {
            const token = localStorage.getItem('cicr_token');
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            // 1. Fetch items, borrow records, audit, and own request status concurrently in parallel
            const [itemsOutcome, borrowOutcome, auditOutcome, requestsOutcome] = await Promise.allSettled([
                fetch(`${API_BASE}/items`, { headers }),
                token ? fetch(`${API_BASE}/borrow/history`, { headers }) : Promise.reject('No token'),
                token ? fetch(`${API_BASE}/audit`, { headers }) : Promise.reject('No token'),
                token ? fetch(`${API_BASE}/borrow/requests`, { headers }) : Promise.reject('No token')
            ]);

            let dbItems: any[] = [];
            if (itemsOutcome.status === 'fulfilled' && itemsOutcome.value.ok) {
                try {
                    const json = await itemsOutcome.value.json();
                    dbItems = json.data || [];
                } catch { }
            }

            let liveBorrows: any[] = [];
            if (borrowOutcome.status === 'fulfilled' && borrowOutcome.value.ok) {
                try {
                    const bJson = await borrowOutcome.value.json();
                    liveBorrows = bJson.data || [];
                } catch (be) {
                    console.warn('Live borrow parse failed:', be);
                }
            }

            if (dbItems.length > 0) {
                // Map Supabase inventory format to frontend InventoryItem format
                inventory = dbItems.map((item: any) => {
                    let cat = (item.category || '').toLowerCase();
                    if (cat.includes('controller') || cat.includes('mcu') || cat.includes('board') || cat.includes('programmer')) cat = 'microcontrollers';
                    else if (cat.includes('sensor')) cat = 'sensors';
                    else if (cat.includes('actuator') || cat.includes('motor') || cat.includes('esc') || cat.includes('servo') || cat.includes('driver')) cat = 'actuators';
                    else if (cat.includes('power') || cat.includes('battery') || cat.includes('charge') || cat.includes('supply')) cat = 'power';
                    else if (cat.includes('tool') || cat.includes('comm') || cat.includes('display') || cat.includes('remote') || cat.includes('cable') || cat.includes('mechanical') || cat.includes('misc')) cat = 'tools';

                    const itemBorrows = liveBorrows
                        .filter((b: any) => (b.inventory_id === item.id || b.item_id === item.id) && (b.status === 'BORROWED' || b.status === 'RETURN_REQUESTED'))
                        .map((b: any) => ({
                            id: b.id,
                            userId: b.user_id || b.users?.id,
                            email: b.users?.email || b.borrower_email || b.email,
                            borrowerEmail: b.users?.email || b.borrower_email || b.email,
                            name: b.users?.name || b.borrower_name || 'Student',
                            roll: b.users?.roll_number || b.roll_number || 'ID',
                            rollNumber: b.users?.roll_number || b.roll_number,
                            qty: Number(b.quantity) || 1,
                            purpose: b.purpose || 'Robotics Project',
                            date: b.borrowed_at ? b.borrowed_at.split('T')[0] : new Date().toISOString().split('T')[0],
                            dueDate: b.due_date ? b.due_date.split('T')[0] : '',
                            status: b.status || 'BORROWED'
                        }));

                    const borrowedSum = itemBorrows.reduce((sum: number, rec: any) => sum + rec.qty, 0);
                    const totalQty = Number(item.quantity) || 0;
                    const availableQty = (item.available_quantity !== undefined && item.available_quantity !== null)
                        ? Math.min(totalQty, Math.max(0, Number(item.available_quantity)))
                        : Math.max(0, totalQty - borrowedSum);

                    let cleanName = (item.name || '').trim();
                    if (cleanName.toLowerCase().includes('model unclear') || cleanName.toLowerCase() === 'arduino board') {
                        cleanName = 'Arduino Uno R3';
                    }

                    return {
                        id: String(item.id),
                        name: cleanName,
                        category: cat || 'microcontrollers',
                        quantity: totalQty,
                        availableQuantity: availableQty,
                        location: item.location || 'Lab Shelf',
                        specs: item.description || 'No specifications provided.',
                        image: item.image || (cat === 'sensors' ? 'drone.jpg' : cat === 'actuators' || cat === 'power' ? 'rover.jpg' : 'microchip.jpg'),
                        tags: Array.isArray(item.tags) ? item.tags : typeof item.tags === 'string' ? JSON.parse(item.tags || '[]') : [],
                        borrowedBy: itemBorrows
                    };
                });

                // Save to localStorage cache
                this.save();
            }

            // Process audit logs
            if (auditOutcome.status === 'fulfilled' && auditOutcome.value.ok) {
                try {
                    const aJson = await auditOutcome.value.json();
                    if (Array.isArray(aJson.data)) {
                        logs = aJson.data.map((l: any) => ({
                            type: l.action.toLowerCase().includes('borrow') ? 'borrow'
                                : l.action.toLowerCase().includes('return') ? 'return'
                                    : l.action.toLowerCase().includes('add') ? 'add' : 'system',
                            timestamp: l.created_at || new Date().toISOString(),
                            text: l.description || l.action
                        }));
                        localStorage.setItem('cicr_logs', JSON.stringify(logs));
                    }
                } catch (ae) {
                    console.warn('Live audit parse failed:', ae);
                }
            }

            // Sync canonical request statuses from server
            if (requestsOutcome.status === 'fulfilled' && requestsOutcome.value.ok) {
                try {
                    const rJson = await requestsOutcome.value.json();
                    const serverRequests = Array.isArray(rJson.data) ? rJson.data : [];
                    if (serverRequests.length > 0) {
                        const mappedServerReqs: RequestRecord[] = serverRequests.map((r: any) => ({
                            id: r.id,
                            type: r.type || 'ISSUE',
                            borrowId: r.borrowId,
                            returnQuantity: r.returnQuantity,
                            itemId: r.itemId,
                            itemName: r.itemName,
                            name: r.borrowerName,
                            roll: r.rollNumber,
                            qty: r.type === 'RETURN' ? (r.returnQuantity || r.quantity || 1) : (r.quantity || 1),
                            purpose: r.purpose,
                            dueDate: r.dueDate,
                            status: r.status,
                            requestedAt: r.requestedAt,
                            reviewedAt: r.reviewedAt,
                            reviewedBy: r.reviewedBy,
                            reviewNote: r.reviewNote
                        }));

                        // Deduplicate with any local unsynced pending requests
                        const seenSyncIds = new Set<string>();
                        const mergedSync: RequestRecord[] = [];
                        for (const sr of mappedServerReqs) {
                            seenSyncIds.add(sr.id);
                            if (sr.borrowId) seenSyncIds.add(sr.borrowId);
                            mergedSync.push(sr);
                        }
                        for (const lr of (requests || [])) {
                            if (!seenSyncIds.has(lr.id) && !(lr.borrowId && seenSyncIds.has(lr.borrowId))) {
                                mergedSync.push(lr);
                            }
                        }
                        requests = mergedSync;
                        localStorage.setItem('cicr_requests', JSON.stringify(requests));
                    }
                } catch (re) {
                    console.warn('Live request status parse failed:', re);
                }
            }

            if (window.dashboard && dbItems.length > 0) {
                window.dashboard.renderStats();
                window.dashboard.renderInventory();
            }
        } catch (err) {
            console.error('Realtime Supabase sync failed:', err);
        } finally {
            this.updateNotificationBadges();
        }
    }

    static save() {
        localStorage.setItem('cicr_inventory', JSON.stringify(inventory));
        localStorage.setItem('cicr_logs', JSON.stringify(logs));
        localStorage.setItem('cicr_requests', JSON.stringify(requests));
        this.updateNotificationBadges();
    }

    static isNotificationsCleared: boolean = false;

    static updateNotificationBadges() {
        const todayStr = new Date().toISOString().split('T')[0];
        const role = ModalManager.getCurrentRole();
        const isAdmin = role === 'ADMIN';

        const storedUser = JSON.parse(localStorage.getItem('cicr_user') || '{}');
        const authName = (localStorage.getItem('cicr_auth') || '').toLowerCase().trim();
        const userName = (storedUser.name || '').toLowerCase().trim();
        const userEmail = (storedUser.email || '').toLowerCase().trim();
        const userRoll = (storedUser.roll_number || storedUser.roll || '').toLowerCase().trim();

        const isUserLoan = (rec: BorrowRecord) => ModalManager.isUserLoanMatch(rec);

        const isUserRequest = (req: any) => {
            const rName = (req.name || req.borrowerName || '').toLowerCase().trim();
            const rRoll = (req.roll || req.rollNumber || '').toLowerCase().trim();
            const rEmail = (req.email || req.borrowerEmail || '').toLowerCase().trim();
            if (userRoll && rRoll && rRoll === userRoll) return true;
            if (userEmail && rEmail && rEmail === userEmail) return true;
            if (userName && rName && (rName === userName || rName.includes(userName) || userName.includes(rName))) return true;
            if (authName && (rName === authName || rEmail === authName)) return true;
            return false;
        };

        let overdueCount = 0;
        let activeLoansCount = 0;
        let depletedStockCount = 0;

        inventory.forEach((item) => {
            const total = Number(item.quantity) || 0;
            const available = typeof item.availableQuantity === 'number'
                ? item.availableQuantity
                : total;

            // Only count as critical stock alert if item is completely depleted (0 available out of >0 total)
            if (isAdmin && available <= 0 && total > 0) {
                depletedStockCount++;
            }

            (item.borrowedBy || []).forEach((rec) => {
                if (rec.returned) return;

                const belongsToUser = isUserLoan(rec);
                if (!isAdmin && !belongsToUser) return;

                activeLoansCount++;

                let due = rec.dueDate;
                if (!due && rec.date) {
                    const bTime = new Date(rec.date).getTime();
                    if (!isNaN(bTime)) {
                        due = new Date(bTime + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    }
                }
                if (due && due < todayStr) {
                    overdueCount++;
                }
            });
        });

        // Collect all pending hardware requests from all available caches
        const allPendingHwRequests: any[] = [];
        const seenPendingIds = new Set<string>();
        const dismissedRaw = localStorage.getItem('cicr_dismissed_requests');
        const dismissedSet: Set<string> = dismissedRaw ? new Set(JSON.parse(dismissedRaw)) : new Set();
        dismissedSet.add('req_1789341756703_7d6b6494');

        if (typeof AdminManager !== 'undefined' && Array.isArray(AdminManager.hardwareRequests)) {
            AdminManager.hardwareRequests.forEach(r => {
                if (r && r.status === 'PENDING' && !seenPendingIds.has(r.id) && !dismissedSet.has(r.id)) {
                    seenPendingIds.add(r.id);
                    allPendingHwRequests.push(r);
                }
            });
        }

        (requests || []).forEach(r => {
            if (r && r.status === 'PENDING' && !seenPendingIds.has(r.id) && !dismissedSet.has(r.id)) {
                seenPendingIds.add(r.id);
                allPendingHwRequests.push(r);
            }
        });

        const storedReqRaw = localStorage.getItem('cicr_requests');
        if (storedReqRaw) {
            try {
                const parsed = JSON.parse(storedReqRaw);
                (parsed || []).forEach((r: any) => {
                    if (r && r.status === 'PENDING' && !seenPendingIds.has(r.id) && !dismissedSet.has(r.id)) {
                        seenPendingIds.add(r.id);
                        allPendingHwRequests.push(r);
                    }
                });
            } catch { }
        }

        const pendingHwCount = isAdmin
            ? allPendingHwRequests.length
            : allPendingHwRequests.filter(r => isUserRequest(r)).length;

        let pendingUsersCount = 0;
        if (isAdmin && typeof AdminManager !== 'undefined' && Array.isArray(AdminManager.users)) {
            pendingUsersCount = AdminManager.users.filter(u => u.status === 'PENDING').length;
        }

        let totalAlerts = 0;
        if (this.isNotificationsCleared) {
            totalAlerts = 0;
        } else if (isAdmin) {
            totalAlerts = overdueCount + pendingHwCount + pendingUsersCount + depletedStockCount;
        } else {
            totalAlerts = overdueCount + activeLoansCount + pendingHwCount;
        }

        const sidebarBadge = document.getElementById('sidebar-notif-badge');
        const sidebarBeacon = document.getElementById('sidebar-notif-beacon') || (document.querySelector('.notif-radar-beacon') as HTMLElement | null);
        const navBadge = document.getElementById('nav-bell-badge');

        const alertStr = String(totalAlerts);
        if (totalAlerts > 0) {
            if (sidebarBadge) {
                if (sidebarBadge.innerText !== alertStr) sidebarBadge.innerText = alertStr;
                if (sidebarBadge.style.display !== 'inline-flex') sidebarBadge.style.display = 'inline-flex';
                if (!sidebarBadge.classList.contains('pulse')) sidebarBadge.classList.add('pulse');
            }
            if (sidebarBeacon) {
                if (sidebarBeacon.style.display !== 'block') sidebarBeacon.style.display = 'block';
            }
            if (navBadge) {
                if (navBadge.innerText !== alertStr) navBadge.innerText = alertStr;
                if (navBadge.style.display !== 'inline-flex') navBadge.style.display = 'inline-flex';
                if (!navBadge.classList.contains('pulse')) navBadge.classList.add('pulse');
            }
        } else {
            if (sidebarBadge) {
                if (sidebarBadge.innerText !== '0') sidebarBadge.innerText = '0';
                if (sidebarBadge.style.display !== 'none') sidebarBadge.style.display = 'none';
                if (sidebarBadge.classList.contains('pulse')) sidebarBadge.classList.remove('pulse');
            }
            if (sidebarBeacon) {
                if (sidebarBeacon.style.display !== 'none') sidebarBeacon.style.display = 'none';
            }
            if (navBadge) {
                if (navBadge.innerText !== '0') navBadge.innerText = '0';
                if (navBadge.style.display !== 'none') navBadge.style.display = 'none';
                if (navBadge.classList.contains('pulse')) navBadge.classList.remove('pulse');
            }
        }
    }

    static startAutoSync(intervalMs = 3000) {
        if ((window as any)._cicrAutoSyncTimer) {
            clearInterval((window as any)._cicrAutoSyncTimer);
        }
        (window as any)._cicrAutoSyncTimer = setInterval(async () => {
            // Do not consume bandwidth or hammer backend when browser tab is hidden/minimized
            if (typeof document !== 'undefined' && document.hidden) return;

            await this.syncFromBackend();
            const role = ModalManager.getCurrentRole();
            if (role === 'ADMIN' && typeof AdminManager !== 'undefined') {
                await AdminManager.loadHardwareRequests();
                await AdminManager.loadUsers();
            }
            this.updateNotificationBadges();
        }, intervalMs);
    }

    static addLog(type: ActivityLog['type'], text: string, itemId?: string) {
        const date = new Date();
        const timestamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        logs.unshift({ type, timestamp, text });
        this.save();

        // Asynchronously persist to backend 7-day audit ledger
        const token = localStorage.getItem('cicr_token');
        if (token) {
            let action = 'System Event';
            if (type === 'borrow') action = 'Borrowed';
            else if (type === 'return') action = 'Returned';
            else if (type === 'add') action = 'Item Added';
            else if (type === 'approve') action = 'Hardware Approved';
            else if (type === 'reject') action = 'Hardware Rejected';
            else if (type === 'request') action = 'Hardware Requested';
            else if (type === 'low_stock') action = 'Stock Alert';

            const plainText = text.replace(/<[^>]*>?/gm, '');
            fetch(`${API_BASE}/audit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    action,
                    description: plainText,
                    itemId: itemId || null
                })
            }).catch(() => {});
        }
    }
}

// ==========================================
// 4. Dashboard Manager Class
// ==========================================
class DashboardManager {
    private activeCategory = 'all';
    public searchQuery = '';
    public lastRenderedFingerprint = '';
    private listenersInitialized = false;
    private mobileSidebarOpen = false;

    private appContainer: HTMLElement;
    private inventoryGrid: HTMLElement;
    private noResults: HTMLElement;
    private searchInput: HTMLInputElement;
    private clearSearchBtn: HTMLElement;
    private resultsCount: HTMLElement;

    private statTotal: HTMLElement;
    private statBorrowed: HTMLElement;
    private statLow: HTMLElement;
    private statOut: HTMLElement;
    private mobileSidebarToggle: HTMLButtonElement | null;
    private mobileSidebarBackdrop: HTMLElement | null;

    public activeStockFilter: 'all' | 'borrowed' | 'low' | 'out' = 'all';
    private activeStockPill: HTMLElement | null = null;

    private clockTimerId: any = null;

    constructor() {
        this.appContainer = document.getElementById('app-container')!;
        this.mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle') as HTMLButtonElement | null;
        this.mobileSidebarBackdrop = document.getElementById('mobile-sidebar-backdrop');
        this.inventoryGrid = document.getElementById('inventory-grid')!;
        this.noResults = document.getElementById('no-results')!;
        this.searchInput = document.getElementById('search-input') as HTMLInputElement;
        this.clearSearchBtn = document.getElementById('clear-search')!;
        this.resultsCount = document.getElementById('results-count')!;
        this.activeStockPill = document.getElementById('active-stock-pill');

        this.statTotal = document.getElementById('stat-total')!;
        this.statBorrowed = document.getElementById('stat-borrowed')!;
        this.statLow = document.getElementById('stat-low')!;
        this.statOut = document.getElementById('stat-out')!;

        this.init();
        this.loadInventory();
    }

    public init() {
        this.renderStats();
        this.renderInventory();
        AuthManager.updateAdminVisibility(ModalManager.getCurrentRole());
        if (!this.listenersInitialized) {
            this.setupEventListeners();
            this.listenersInitialized = true;
        }
    }

    static formatLogDateTime(raw: string | Date | undefined): { dateStr: string; timeStr: string } {
        if (!raw) {
            const now = new Date();
            return {
                dateStr: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                timeStr: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\u202f/g, ' ').toUpperCase()
            };
        }

        let d: Date | null = null;
        const s = String(raw).trim();
        const hasTime = s.includes(':');

        if (raw instanceof Date) {
            d = raw;
        } else if (hasTime) {
            const isoCandidate = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s;
            const parsed = new Date(isoCandidate);
            if (!isNaN(parsed.getTime())) {
                d = parsed;
            }
        }

        if (d && !isNaN(d.getTime())) {
            const dateStr = d.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
            }); // e.g. "13 Sep 2026"
            const timeStr = d.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            }).replace(/\u202f/g, ' ').toUpperCase(); // e.g. "03:13 PM"
            return { dateStr, timeStr };
        }

        // Check if date-only format YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
            const [year, month, day] = s.split('-');
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const mIdx = parseInt(month, 10) - 1;
            if (mIdx >= 0 && mIdx < 12) {
                return {
                    dateStr: `${parseInt(day, 10)} ${monthNames[mIdx]} ${year}`,
                    timeStr: ''
                };
            }
        }

        // Fallback for strings with T or space
        if (s.includes('T') || s.includes(' ')) {
            const sep = s.includes('T') ? 'T' : ' ';
            const [datePart, timePart] = s.split(sep);
            let formattedDate = datePart;
            if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
                const [year, month, day] = datePart.split('-');
                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                const mIdx = parseInt(month, 10) - 1;
                if (mIdx >= 0 && mIdx < 12) {
                    formattedDate = `${parseInt(day, 10)} ${monthNames[mIdx]} ${year}`;
                }
            }
            return {
                dateStr: formattedDate || s,
                timeStr: timePart ? timePart.slice(0, 5) : ''
            };
        }

        return { dateStr: s, timeStr: '' };
    }

    public setMobileSidebar(open: boolean) {
        const shouldOpen = open && window.innerWidth <= 1100;
        this.mobileSidebarOpen = shouldOpen;
        this.appContainer.classList.toggle('sidebar-open', shouldOpen);
        this.mobileSidebarToggle?.setAttribute('aria-expanded', String(shouldOpen));
        if (this.mobileSidebarBackdrop) {
            this.mobileSidebarBackdrop.style.display = shouldOpen ? 'block' : 'none';
        }
        document.body.style.overflow = shouldOpen ? 'hidden' : '';
    }

    private startClock() {
        if (this.clockTimerId) clearInterval(this.clockTimerId);

        const updateTime = () => {
            const now = new Date();

            // Format time: hh:mm:ss am/pm
            let hours = now.getHours();
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const ampm = hours >= 12 ? 'pm' : 'am';
            hours = hours % 12;
            hours = hours ? hours : 12; // the hour '0' should be '12'
            const formattedHours = String(hours).padStart(2, '0');

            const clockEl = document.getElementById('dashboard-clock');
            if (clockEl) {
                clockEl.innerText = `${formattedHours}:${minutes}:${seconds} ${ampm}`;
            }

            // Format date: Tuesday, 17 March 2026
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const dayName = days[now.getDay()];
            const dateNum = now.getDate();
            const monthName = months[now.getMonth()];
            const year = now.getFullYear();

            const dateEl = document.getElementById('dashboard-date');
            if (dateEl) {
                dateEl.innerText = `${dayName}, ${dateNum} ${monthName} ${year}`;
            }

            // Update time-of-day greeting
            const curHour = now.getHours();
            let timeOfDay = 'evening';
            if (curHour < 12) {
                timeOfDay = 'morning';
            } else if (curHour < 17) {
                timeOfDay = 'afternoon';
            }

            const username = localStorage.getItem('cicr_auth') || 'Operator';
            const greetingEl = document.getElementById('dashboard-greeting');
            if (greetingEl) {
                greetingEl.innerText = `Good ${timeOfDay}, ${username}`;
            }
        };

        updateTime();
        this.clockTimerId = setInterval(updateTime, 1000);
    }

    private setupEventListeners() {
        // Ticking Clock and dynamic greeting initialization
        this.startClock();

        const closeMobileSidebar = () => this.setMobileSidebar(false);
        const toggleMobileSidebar = () => this.setMobileSidebar(!this.mobileSidebarOpen);

        this.mobileSidebarToggle?.addEventListener('click', () => {
            toggleMobileSidebar();
        });

        this.mobileSidebarBackdrop?.addEventListener('click', () => {
            closeMobileSidebar();
        });

        const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
        sidebarCloseBtn?.addEventListener('click', () => {
            closeMobileSidebar();
        });

        const sidebarResetPassBtn = document.getElementById('sidebar-reset-pass-btn');
        sidebarResetPassBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeMobileSidebar();
            PasswordResetManager.open();
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 1100) {
                closeMobileSidebar();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeMobileSidebar();
            }
        });

        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            lucide.createIcons();
        }

        // 1. Sidebar Nav click listeners
        const sidebarLinks = document.querySelectorAll('.sidebar-nav-link');
        const sections = document.querySelectorAll('#app-main-content > section');
        const breadcrumbActive = document.getElementById('breadcrumb-current');

        const switchSection = (targetId: string) => {
            sections.forEach(node => {
                const sec = node as HTMLElement;
                if (sec.id === targetId) {
                    sec.classList.add('active');
                    sec.style.display = 'flex';
                    if (sec.id === 'inventory-view' || sec.id === 'projects-view' || sec.id === 'meetings-view' || sec.id === 'events-view' || sec.id === 'developers-view') {
                        sec.style.display = 'block';
                    }
                } else {
                    sec.classList.remove('active');
                    sec.style.display = 'none';
                }
            });

            // Toggle body classes for current view
            document.body.classList.toggle('view-dashboard-view', targetId === 'dashboard-view');
            document.body.classList.toggle('view-developers-view', targetId === 'developers-view');
            document.body.classList.toggle('view-admin-view', targetId === 'admin-view');
            document.body.classList.toggle('view-inventory-view', targetId === 'inventory-view');



            // Refresh Lucide icons if needed
            if (typeof lucide !== 'undefined' && lucide.createIcons) {
                lucide.createIcons();
            }

            // Update sidebar link active class
            sidebarLinks.forEach(link => {
                const target = (link as HTMLElement).dataset.target;
                if (target === targetId) {
                    link.classList.add('active');
                } else {
                    link.classList.remove('active');
                }
            });

            // Update breadcrumbs text
            if (breadcrumbActive) {
                const nameMap: Record<string, string> = {
                    'dashboard-view': 'DASHBOARD',
                    'projects-view': 'PROJECTS',
                    'meetings-view': 'MEETINGS',
                    'events-view': 'EVENTS',
                    'inventory-view': 'INVENTORY',
                    'developers-view': 'MEET THE DEVELOPERS',
                    'admin-view': 'ADMIN MANAGEMENT'
                };
                breadcrumbActive.textContent = nameMap[targetId] || targetId.toUpperCase();
            }

            // If switching to inventory-view, trigger render/refresh
            if (targetId === 'inventory-view') {
                this.renderInventory();
            }

            // If switching to admin-view, load admin data
            if (targetId === 'admin-view') {
                if (ModalManager.getCurrentRole() !== 'ADMIN') {
                    ToastManager.show('Access Restricted', 'Admin privileges required to access Admin Portal.', 'warning');
                    switchSection('inventory-view');
                    return;
                }
                AdminManager.loadUsers(true);
                AdminManager.loadHardwareRequests(true);
                AdminManager.loadAuditLogs();
            }

            // If switching to developers-view, render team showcase with Team as default
            if (targetId === 'developers-view') {
                if (typeof TeamShowcaseManager !== 'undefined') {
                    TeamShowcaseManager.init();
                    TeamShowcaseManager.setCategory('team');
                }
            }

            closeMobileSidebar();
        };

        (this as any).switchSection = switchSection;
        switchSection('dashboard-view');

        sidebarLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const target = (link as HTMLElement).dataset.target;
                if (target) {
                    switchSection(target);
                    closeMobileSidebar();
                }
            });
        });

        // Floating Navbar developers link
        const navDevs = document.getElementById('nav-developers');
        if (navDevs) {
            navDevs.addEventListener('click', () => switchSection('developers-view'));
        }

        // 2. Dashboard action pills switching listeners
        const pillProjects = document.getElementById('dashboard-pill-projects');
        if (pillProjects) {
            pillProjects.addEventListener('click', () => switchSection('projects-view'));
        }
        const pillMeetings = document.getElementById('dashboard-pill-meetings');
        if (pillMeetings) {
            pillMeetings.addEventListener('click', () => switchSection('meetings-view'));
        }
        const pillEvents = document.getElementById('dashboard-pill-events');
        if (pillEvents) {
            pillEvents.addEventListener('click', () => switchSection('events-view'));
        }
        const pillAdmin = document.getElementById('dashboard-pill-admin');
        if (pillAdmin) {
            pillAdmin.addEventListener('click', () => {
                ModalManager.open('add-item-modal');
            });
        }
        const pillCommunity = document.getElementById('dashboard-pill-community');
        if (pillCommunity) {
            pillCommunity.addEventListener('click', () => {
                ModalManager.openAboutModal();
            });
        }

        // 3. Dashboard card switching listeners
        const cardVault = document.getElementById('dash-card-vault');
        if (cardVault) {
            cardVault.addEventListener('click', () => switchSection('inventory-view'));
        }
        const cardLogs = document.getElementById('dash-card-logs');
        if (cardLogs) {
            cardLogs.addEventListener('click', () => {
                ModalManager.openLogsDrawer();
            });
        }
        const cardDevs = document.getElementById('dash-card-devs');
        if (cardDevs) {
            cardDevs.addEventListener('click', () => switchSection('developers-view'));
        }
        const cardAdmin = document.getElementById('dash-card-admin');
        if (cardAdmin) {
            cardAdmin.addEventListener('click', () => switchSection('admin-view'));
        }
        const cardProjects = document.getElementById('dash-card-projects');
        if (cardProjects) {
            cardProjects.addEventListener('click', () => switchSection('projects-view'));
        }
        const cardMeetings = document.getElementById('dash-card-meetings');
        if (cardMeetings) {
            cardMeetings.addEventListener('click', () => switchSection('meetings-view'));
        }
        const cardDiscussions = document.getElementById('dash-card-discussions');
        if (cardDiscussions) {
            cardDiscussions.addEventListener('click', () => {
                ModalManager.openAboutModal();
            });
        }
        const cardRecruitment = document.getElementById('dash-card-recruitment');
        if (cardRecruitment) {
            cardRecruitment.addEventListener('click', () => {
                ModalManager.openAboutModal();
            });
        }

        // 4. Notifications & History Drawer trigger
        const notifBtn = document.getElementById('sidebar-notifications-btn');
        if (notifBtn) {
            notifBtn.addEventListener('click', () => {
                closeMobileSidebar();
                ModalManager.openLogsDrawer();
            });
        }

        // 5. Password Reset / Change Key trigger
        const resetPassBtn = document.getElementById('sidebar-reset-pass-btn');
        if (resetPassBtn && !resetPassBtn.dataset.bound) {
            resetPassBtn.dataset.bound = 'true';
            resetPassBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMobileSidebar();
                PasswordResetManager.open();
            });
        }

        // 6. Profile Logout button
        const logoutBtn = document.getElementById('sidebar-logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // trigger logout directly on AuthManager
                const oldLogoutBtn = document.getElementById('nav-logout');
                if (oldLogoutBtn) {
                    oldLogoutBtn.click();
                } else {
                    localStorage.removeItem('cicr_auth');
                    window.location.reload();
                }
            });
        }

        // 7. Inventory Search Input listeners
        this.searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
            this.clearSearchBtn.style.display = this.searchQuery ? 'block' : 'none';
            this.renderInventory();
        });

        this.clearSearchBtn.addEventListener('click', () => {
            this.searchInput.value = '';
            this.searchQuery = '';
            this.clearSearchBtn.style.display = 'none';
            this.renderInventory();
            this.searchInput.focus();
        });

        // 8. Sync active category states between sidebar items and tag pills
        const sidebarItems = document.querySelectorAll('.sidebar-item');
        const tagPills = document.querySelectorAll('.tag-pill');

        const selectCategory = (category: string) => {
            this.activeCategory = category;

            sidebarItems.forEach(item => {
                const itemCat = (item as HTMLElement).dataset.category || 'all';
                if (itemCat === category) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });

            tagPills.forEach(pill => {
                const pillCat = (pill as HTMLElement).dataset.category || 'all';
                if (pillCat === category) {
                    pill.classList.add('active');
                } else {
                    pill.classList.remove('active');
                }
            });

            this.renderInventory();
        };

        sidebarItems.forEach(item => {
            item.addEventListener('click', () => {
                const cat = (item as HTMLElement).dataset.category || 'all';
                selectCategory(cat);
                switchSection('inventory-view');
            });
        });

        tagPills.forEach(pill => {
            pill.addEventListener('click', () => {
                const cat = (pill as HTMLElement).dataset.category || 'all';
                selectCategory(cat);
            });
        });

        // 9. Theme Switcher Buttons listeners
        const themeBtnDark = document.getElementById('theme-btn-dark');
        const themeBtnLight = document.getElementById('theme-btn-light');
        const themeBtnPink = document.getElementById('theme-btn-pink');

        themeBtnDark?.addEventListener('click', () => ThemeManager.applyTheme('cyberpunk'));
        themeBtnLight?.addEventListener('click', () => ThemeManager.applyTheme('light'));
        themeBtnPink?.addEventListener('click', () => ThemeManager.applyTheme('sakura'));

        // 10. Interactive Stat Bubbles Filter Listeners (Total, Active Loans, Low Reserves, Out of Stock)
        const statBubbles = document.querySelectorAll('.stat-bubble-new');
        statBubbles.forEach(bubble => {
            bubble.addEventListener('click', () => {
                const target = (bubble as HTMLElement).dataset.stockFilter || 'all';
                if (this.activeStockFilter === target && target !== 'all') {
                    this.activeStockFilter = 'all';
                } else {
                    this.activeStockFilter = target as any;
                }
                this.updateStatBubbleUI();
                this.renderInventory(true);
            });
        });
    }

    public updateStatBubbleUI() {
        const statBubbles = document.querySelectorAll('.stat-bubble-new');
        statBubbles.forEach(bubble => {
            const f = (bubble as HTMLElement).dataset.stockFilter || 'all';
            if (this.activeStockFilter === 'all') {
                bubble.classList.remove('active-filter');
            } else if (f === this.activeStockFilter) {
                bubble.classList.add('active-filter');
            } else {
                bubble.classList.remove('active-filter');
            }
        });

        if (this.activeStockPill) {
            if (this.activeStockFilter === 'all') {
                this.activeStockPill.style.display = 'none';
                this.activeStockPill.innerHTML = '';
            } else {
                const labels: Record<string, string> = {
                    borrowed: 'Active Loans',
                    low: 'Low Reserves (≤ 50%)',
                    out: 'Out of Stock'
                };
                const filterText = labels[this.activeStockFilter] || this.activeStockFilter;
                this.activeStockPill.style.display = 'inline-flex';
                this.activeStockPill.innerHTML = `
                    <span class="active-stock-pill-text"><i data-lucide="filter"></i> ${filterText}</span>
                    <button class="btn-clear-stock-filter" title="Clear Stock Filter">✕</button>
                `;
                const clearBtn = this.activeStockPill.querySelector('.btn-clear-stock-filter');
                clearBtn?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.activeStockFilter = 'all';
                    this.updateStatBubbleUI();
                    this.renderInventory(true);
                });
                lucide.createIcons();
            }
        }
    }

    public renderStats() {
        let totalQty = 0;
        let checkedOutQty = 0;
        let lowStockCount = 0;
        let outOfStockCount = 0;

        const role = ModalManager.getCurrentRole();
        const isAdmin = role === 'ADMIN';

        inventory.forEach(item => {
            totalQty += item.quantity;

            const borrowedSum = (item.borrowedBy || []).reduce((sum, rec) => sum + rec.qty, 0);
            const currentAvailable = typeof item.availableQuantity === 'number'
                ? item.availableQuantity
                : Math.max(0, item.quantity - borrowedSum);

            if (isAdmin) {
                const activeLoans = borrowedSum > 0 ? borrowedSum : Math.max(0, item.quantity - currentAvailable);
                checkedOutQty += activeLoans;
            } else {
                const memberLoans = (item.borrowedBy || []).filter(r => !r.returned && ModalManager.isUserLoanMatch(r));
                checkedOutQty += memberLoans.reduce((sum, rec) => sum + rec.qty, 0);
            }

            const status = getItemStockStatus(item.quantity, currentAvailable);
            if (status.class === 'status-out') {
                outOfStockCount++;
            } else if (status.class === 'status-low') {
                lowStockCount++;
            }
        });

        const totalStr = String(totalQty);
        const borrowedStr = String(checkedOutQty);
        const lowStr = String(lowStockCount);
        const outStr = String(outOfStockCount);

        if (this.statTotal.innerText !== totalStr) this.statTotal.innerText = totalStr;
        if (this.statBorrowed.innerText !== borrowedStr) this.statBorrowed.innerText = borrowedStr;
        if (this.statLow.innerText !== lowStr) this.statLow.innerText = lowStr;
        if (this.statOut.innerText !== outStr) this.statOut.innerText = outStr;
    }

    public renderInventory(force = false) {
        const role = ModalManager.getCurrentRole();
        const isAdmin = role === 'ADMIN';

        const filtered = inventory.filter(item => {
            const matchesCategory = this.activeCategory === 'all' || item.category === this.activeCategory;
            const matchesSearch = item.name.toLowerCase().includes(this.searchQuery) ||
                item.specs.toLowerCase().includes(this.searchQuery) ||
                item.location.toLowerCase().includes(this.searchQuery) ||
                (Array.isArray(item.tags) && item.tags.some((t: string) => t.toLowerCase().includes(this.searchQuery)));

            const borrowedSum = (item.borrowedBy || []).reduce((sum, rec) => sum + rec.qty, 0);
            const available = typeof item.availableQuantity === 'number'
                ? item.availableQuantity
                : Math.max(0, item.quantity - borrowedSum);

            let matchesStock = true;
            if (this.activeStockFilter === 'borrowed') {
                if (isAdmin) {
                    matchesStock = borrowedSum > 0 || available < item.quantity;
                } else {
                    matchesStock = (item.borrowedBy || []).some(r => !r.returned && ModalManager.isUserLoanMatch(r));
                }
            } else if (this.activeStockFilter === 'low') {
                const status = getItemStockStatus(item.quantity, available);
                matchesStock = status.class === 'status-low';
            } else if (this.activeStockFilter === 'out') {
                const status = getItemStockStatus(item.quantity, available);
                matchesStock = status.class === 'status-out';
            }

            return matchesCategory && matchesSearch && matchesStock;
        });

        const currentFingerprint = `${role}_${this.activeCategory}_${this.activeStockFilter}_${this.searchQuery}_` +
            filtered.map(i => `${i.id}_${i.availableQuantity}_${i.quantity}_${i.name}_${i.location}_${(i.borrowedBy || []).map((b: any) => `${b.id}:${b.status}:${b.qty}`).join(',')}`).join('|');

        if (!force && this.lastRenderedFingerprint === currentFingerprint && this.inventoryGrid.children.length === filtered.length) {
            // Inventory data and filters have not changed; do NOT destroy/re-render DOM cards to prevent items popping up repeatedly
            return;
        }

        const isInitial = this.lastRenderedFingerprint === '';
        this.lastRenderedFingerprint = currentFingerprint;

        this.inventoryGrid.innerHTML = '';

        if (filtered.length === 0) {
            this.noResults.style.display = 'flex';
            this.resultsCount.innerText = "Showing 0 items";
            return;
        }

        this.noResults.style.display = 'none';
        const filterSuffix = this.activeStockFilter === 'low' ? ' (Low Reserves)' :
            this.activeStockFilter === 'borrowed' ? ' (Active Loans)' :
                this.activeStockFilter === 'out' ? ' (Out of Stock)' : '';
        this.resultsCount.innerText = `Showing ${filtered.length} component${filtered.length > 1 ? 's' : ''}${filterSuffix}`;

        filtered.forEach((item, index) => {
            const card = this.createCardElement(item, isInitial);
            if (isInitial) {
                card.style.transitionDelay = `${(index % 4) * 0.06}s`;
                this.inventoryGrid.appendChild(card);
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        card.classList.add('active');
                    }, 40);
                });
            } else {
                card.style.transitionDelay = '0s';
                card.classList.add('active');
                this.inventoryGrid.appendChild(card);
            }
        });

        renderLucideIcons(this.inventoryGrid);
    }

    private async loadInventory() {
        await DatabaseManager.syncFromBackend();
        this.renderInventory(true);
        this.renderStats();
    }

    private createCardElement(item: InventoryItem, isInitial = false): HTMLElement {
        const card = document.createElement('div');
        card.className = isInitial ? 'inventory-card glass reveal' : 'inventory-card glass active';

        const borrowedSum = (item.borrowedBy || []).reduce(
            (sum: number, rec: any) => sum + rec.qty,
            0
        );
        const totalQty = Number(item.quantity) || 0;
        const available = typeof item.availableQuantity === 'number'
            ? Math.min(totalQty, Math.max(0, item.availableQuantity))
            : Math.max(0, totalQty - borrowedSum);

        const status = getItemStockStatus(totalQty, available);
        const statusText = status.text;
        const statusClass = status.class;

        const catMap: Record<string, string> = {
            microcontrollers: "MCU",
            sensors: "SENSOR",
            actuators: "ACTUATOR",
            power: "POWER",
            tools: "HARDWARE"
        };
        const categoryLabel = catMap[item.category] || item.category.toUpperCase();

        const itemName = item.name;

        // Dynamic 1-line sizing class so longer component names never get hidden or truncated
        const nameLen = itemName.length;
        const titleSizeClass = nameLen > 28 ? 'title-compact-xs' : nameLen > 18 ? 'title-compact-sm' : '';

        // Shorter, punchier description for aesthetic display
        const cleanSpecs = (item.specs || '').trim();
        let shortDesc = cleanSpecs;
        if (shortDesc.length > 56) {
            const cut = shortDesc.substring(0, 54);
            const lastSpace = cut.lastIndexOf(' ');
            shortDesc = (lastSpace > 24 ? cut.substring(0, lastSpace) : cut).trim() + '...';
        }

        // Shorter location label (extracts sub-location e.g. "Rack S1, Box 1")
        let shortLocation = item.location || 'Lab Vault';
        if (shortLocation.includes(' - ')) {
            shortLocation = shortLocation.split(' - ')[1].trim();
        }

        // Mini tech tags (up to 2 clean tags)
        const rawTags = Array.isArray(item.tags) ? item.tags : [];
        const miniTags = rawTags
            .filter((t: string) => !['Sensors', 'Controllers', 'Actuators', 'Power', 'Tools', 'Mechanical'].includes(t))
            .slice(0, 2);
        const miniTagsHtml = miniTags.length > 0 ? `
            <div class="card-tags-row">
                ${miniTags.map((t: string) => `<span class="card-mini-tag">#${AdminManager.escapeHtml(t)}</span>`).join('')}
            </div>
        ` : '';

        // Availability progress percentage (relative to true total quantity)
        const fillPercent = totalQty > 0 ? Math.min(100, Math.round((available / totalQty) * 100)) : 0;

        const isAdmin = ModalManager.getCurrentRole() === 'ADMIN';
        const deleteBtnHtml = isAdmin ? `
            <button class="btn-card-delete-item" data-id="${item.id}" data-name="${AdminManager.escapeHtml(itemName)}" onclick="event.stopPropagation(); event.preventDefault(); window.adminDeleteItem('${item.id}', '${AdminManager.escapeHtml(itemName)}')" title="Delete Component from Inventory">
                <i data-lucide="trash-2"></i>
            </button>
        ` : '';

        const myLoans = (item.borrowedBy || []).filter((r: any) => !r.returned && ModalManager.isUserLoanMatch(r));
        const myLoanTotal = myLoans.reduce((sum: number, r: any) => sum + (Number(r.qty) || 0), 0);
        const myPendingReturn = myLoans.some((r: any) => (r as any).status === 'RETURN_REQUESTED');
        const myLoanBadgeHtml = myLoanTotal > 0 ? `
            <div class="card-loan-action-pill" style="margin-top: 8px; display: flex; align-items: center; justify-content: space-between; width: 100%; box-sizing: border-box; background: ${myPendingReturn ? 'rgba(255, 183, 3, 0.12)' : 'rgba(0, 240, 255, 0.08)'}; border: 1px solid ${myPendingReturn ? 'rgba(255, 183, 3, 0.35)' : 'rgba(0, 240, 255, 0.28)'}; border-radius: 6px; padding: 5px 10px; font-size: 11px; color: ${myPendingReturn ? '#ffb703' : 'var(--neon-cyan)'}; cursor: pointer; transition: all 0.2s ease;">
                <span style="display: inline-flex; align-items: center; gap: 5px; font-weight: 600;">
                    <i data-lucide="${myPendingReturn ? 'clock' : 'package-check'}" style="width: 12px; height: 12px;"></i> ${myPendingReturn ? `Return Pending (${myLoanTotal} issued)` : `You have ${myLoanTotal} issued`}
                </span>
                <span style="font-weight: 700; text-decoration: underline; letter-spacing: 0.5px; display: inline-flex; align-items: center; gap: 3px;">
                    ${myPendingReturn ? 'View Status' : 'Return'} <i data-lucide="${myPendingReturn ? 'arrow-right' : 'corner-up-left'}" style="width: 11px; height: 11px;"></i>
                </span>
            </div>
        ` : '';

        card.innerHTML = `
            <div class="card-glow-bar bar-${statusClass}"></div>
            <div class="card-header">
                <span class="card-category-badge cat-${item.category}">${categoryLabel}</span>
                <div class="card-header-actions">
                    <span class="status-indicator ${statusClass}">
                        <span class="status-indicator-dot"></span>
                        ${statusText}
                    </span>
                    ${deleteBtnHtml}
                </div>
            </div>
            <h3 class="card-title ${titleSizeClass}" title="${AdminManager.escapeHtml(itemName)}">${AdminManager.escapeHtml(itemName)}</h3>
            <p class="card-desc" title="${AdminManager.escapeHtml(item.specs)}">${AdminManager.escapeHtml(shortDesc)}</p>
            ${miniTagsHtml}
            ${myLoanBadgeHtml}
            <div class="card-footer">
                <div class="footer-info" title="${AdminManager.escapeHtml(item.location)}">
                    <span class="info-title">Location</span>
                    <span class="info-content"><i data-lucide="map-pin"></i> ${AdminManager.escapeHtml(shortLocation)}</span>
                </div>
                <div class="footer-info" style="align-items: flex-end;">
                    <span class="info-title">Availability</span>
                    <span class="info-content"><strong class="stock-curr ${statusClass}">${available}</strong> <span class="stock-divider">/</span> ${totalQty}</span>
                    <div class="availability-bar-track">
                        <div class="availability-bar-fill fill-${statusClass}" style="width: ${fillPercent}%"></div>
                    </div>
                </div>
            </div>
        `;

        if (isAdmin) {
            const delBtn = card.querySelector('.btn-card-delete-item');
            if (delBtn) {
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    AdminManager.promptDeleteItem(item.id, item.name);
                });
            }
        }

        if (myLoanTotal > 0) {
            const loanPill = card.querySelector('.card-loan-action-pill');
            if (loanPill) {
                loanPill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (myPendingReturn) {
                        ModalManager.openDetailModal(item);
                    } else {
                        const activeLoan = myLoans.find((r: any) => (r as any).status !== 'RETURN_REQUESTED') || myLoans[0];
                        if (activeLoan) {
                            ModalManager.openReturnModal(activeLoan, item, item.borrowedBy.indexOf(activeLoan));
                        }
                    }
                });
            }
        }

        card.addEventListener('click', () => {
            ModalManager.openDetailModal(item);
        });

        return card;
    }

    public static switchSection(targetId: string) {
        if (window.dashboard && (window.dashboard as any).switchSection) {
            (window.dashboard as any).switchSection(targetId);
        } else {
            const sideLink = document.querySelector(`.sidebar-nav-link[data-target="${targetId}"]`) as HTMLElement;
            if (sideLink) {
                sideLink.click();
            }
        }
    }
}



// ==========================================
// 5. Modal & Form Controller Manager
// ==========================================
class ModalManager {
    static init() {
        document.querySelectorAll('.close-modal, .modal-overlay').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target === el || el.classList.contains('close-modal') || (e.target as HTMLElement)?.closest('.close-modal')) {
                    this.closeAll();
                }
            });
        });

        document.querySelectorAll('.modal-content').forEach(content => {
            content.addEventListener('click', (e) => e.stopPropagation());
        });

        const addForm = document.getElementById('add-item-form') as HTMLFormElement;
        if (addForm) {
            addForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleAddItemSubmit();
            });
        }

        const btnInventoryAdd = document.getElementById('btn-inventory-add-item');
        if (btnInventoryAdd) {
            btnInventoryAdd.addEventListener('click', () => {
                if (this.getCurrentRole() !== 'ADMIN') {
                    ToastManager.show('Admin Access Required', 'Only administrators can register components into the vault.', 'warning');
                    return;
                }
                this.open('add-item-modal');
            });
        }

        const cancelAddBtn = document.getElementById('btn-add-cancel');
        if (cancelAddBtn) {
            cancelAddBtn.addEventListener('click', () => {
                this.close('add-item-modal');
            });
        }

        const borrowForm = document.getElementById('borrow-form') as HTMLFormElement;
        borrowForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleBorrowSubmit();
        });

        document.querySelector('.btn-back-to-detail')!.addEventListener('click', () => {
            this.close('borrow-form-modal');
            this.open('detail-modal');
        });

        document.getElementById('btn-borrow')!.addEventListener('click', () => {
            this.openBorrowFormModal();
        });

        document.querySelector('.btn-close-about')!.addEventListener('click', () => {
            this.close('about-modal');
        });

        const returnQtyForm = document.getElementById('return-qty-form') as HTMLFormElement | null;
        if (returnQtyForm && !returnQtyForm.dataset.bound) {
            returnQtyForm.dataset.bound = 'true';
            returnQtyForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const borrowId = (document.getElementById('return-borrow-id') as HTMLInputElement)?.value;
                const idx = Number((document.getElementById('return-borrow-idx') as HTMLInputElement)?.value) || 0;
                const qtyVal = Number((document.getElementById('return-qty-input') as HTMLInputElement)?.value) || 1;
                await ModalManager.handleReturnSubmission(borrowId, qtyVal, idx);
            });

            const qtyInput = document.getElementById('return-qty-input') as HTMLInputElement | null;
            const btnMinus = document.getElementById('btn-return-qty-minus');
            const btnPlus = document.getElementById('btn-return-qty-plus');
            const btnAll = document.getElementById('btn-return-all-qty');

            btnMinus?.addEventListener('click', () => {
                if (qtyInput) {
                    const cur = parseInt(qtyInput.value, 10) || 1;
                    qtyInput.value = String(Math.max(1, cur - 1));
                    ModalManager.updateReturnQtyPreview();
                }
            });

            btnPlus?.addEventListener('click', () => {
                if (qtyInput) {
                    const max = parseInt(qtyInput.max, 10) || 1;
                    const cur = parseInt(qtyInput.value, 10) || 1;
                    qtyInput.value = String(Math.min(max, cur + 1));
                    ModalManager.updateReturnQtyPreview();
                }
            });

            btnAll?.addEventListener('click', () => {
                if (qtyInput) {
                    qtyInput.value = qtyInput.max || '1';
                    ModalManager.updateReturnQtyPreview();
                }
            });

            qtyInput?.addEventListener('input', () => {
                ModalManager.updateReturnQtyPreview();
            });
            qtyInput?.addEventListener('change', () => {
                ModalManager.updateReturnQtyPreview();
            });
        }
    }

    public static updateReturnQtyPreview() {
        const qtyInput = document.getElementById('return-qty-input') as HTMLInputElement | null;
        const previewEl = document.getElementById('return-qty-preview');
        if (!qtyInput) return;
        const maxVal = Math.max(1, parseInt(qtyInput.max, 10) || 1);
        let currentVal = parseInt(qtyInput.value, 10);
        if (isNaN(currentVal) || currentVal < 1) currentVal = 1;
        if (currentVal > maxVal) currentVal = maxVal;
        qtyInput.value = String(currentVal);

        if (previewEl) {
            if (currentVal >= maxVal) {
                previewEl.innerHTML = `<span style="color:var(--neon-cyan); font-weight:700;">Full Return (${maxVal} units)</span>`;
            } else {
                const remaining = maxVal - currentVal;
                previewEl.innerHTML = `<span style="color:#ffb703; font-weight:700;">Partial Return (${remaining} unit${remaining > 1 ? 's' : ''} stay issued)</span>`;
            }
        }
    }

    public static isUserLoanMatch(rec: BorrowRecord): boolean {
        const storedUser = JSON.parse(localStorage.getItem('cicr_user') || '{}');
        const authName = (localStorage.getItem('cicr_auth') || '').toLowerCase().trim();
        const userName = (storedUser.name || '').toLowerCase().trim();
        const userEmail = (storedUser.email || '').toLowerCase().trim();
        const userRoll = (storedUser.roll_number || storedUser.roll || '').toLowerCase().trim();
        const userId = storedUser.id || '';
        const recUserId = (rec as any).userId || (rec as any).user_id || '';

        // 1. Direct User ID match (most authoritative)
        if (userId && recUserId && userId === recUserId) return true;

        // 2. Exact Roll Number match
        const rRoll = (rec.roll || '').toLowerCase().trim();
        if (userRoll && rRoll && userRoll === rRoll) return true;
        if (userEmail && rRoll && (userEmail.startsWith(`${rRoll}@`) || userEmail === `${rRoll}@mail.jiit.ac.in`)) return true;

        // 3. Exact Email match if rec has email
        const recEmail = ((rec as any).email || (rec as any).borrowerEmail || '').toLowerCase().trim();
        if (userEmail && recEmail && userEmail === recEmail) return true;

        // 4. Exact Name match (guarding against generic placeholders like "member", "student", "user", "admin")
        const rName = (rec.name || '').toLowerCase().trim();
        const isGenericName = (n: string) => !n || ['member', 'student', 'user', 'admin', 'borrower', 'guest'].includes(n) || n.length < 3;
        if (!isGenericName(userName) && !isGenericName(rName) && userName === rName) return true;
        if (!isGenericName(authName) && !isGenericName(rName) && authName === rName) return true;

        return false;
    }

    static open(modalId: string) {
        document.getElementById(modalId)!.classList.add('active');
    }

    static close(modalId: string) {
        document.getElementById(modalId)!.classList.remove('active');
    }

    static closeAll() {
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.classList.remove('active');
        });
        selectedItem = null;
    }

    public static isDesignatedAdminUser(email?: string | null, name?: string | null, username?: string | null): boolean {
        const normEmail = (email || '').toLowerCase().trim();
        const normName = (name || '').toLowerCase().trim();
        const normUser = (username || '').toLowerCase().trim();

        // 1. Gunjan Pal
        if (
            normEmail === '992401210050@mail.jiit.ac.in' ||
            normEmail.includes('992401210050') ||
            normEmail.includes('gunjan') ||
            normName.includes('gunjan') ||
            normUser.includes('gunjan')
        ) {
            return true;
        }

        // 2. Dhruvi Gupta
        if (
            normEmail === '992401030123@mail.jiit.ac.in' ||
            normEmail.includes('992401030123') ||
            normEmail.includes('dhruvi') ||
            normName.includes('dhruvi') ||
            normUser.includes('dhruvi')
        ) {
            return true;
        }

        // 3. Aryan Varshney
        if (
            normEmail === '992401030154@mail.jiit.ac.in' ||
            normEmail.includes('992401030154') ||
            normEmail.includes('aryan') ||
            normName.includes('aryan') ||
            normUser.includes('aryan')
        ) {
            return true;
        }

        // 4. Vardaan Saxena / Master Admins
        if (
            normEmail === 'vardaansaxena096@gmail.com' ||
            normEmail === 'cicrinventory@gmail.com' ||
            normEmail === '992501030399@mail.jiit.ac.in' ||
            normEmail.includes('992501030399') ||
            normEmail.includes('vardaan') ||
            normName.includes('vardaan') ||
            normUser.includes('vardaan') ||
            normUser === 'srvkiller09' ||
            normUser === ADMIN_USERNAME.toLowerCase()
        ) {
            return true;
        }

        return false;
    }

    public static getCurrentRole(): UserRole {
        const userStr = localStorage.getItem('cicr_user');
        if (userStr) {
            try {
                const user = JSON.parse(userStr);
                const email = (user.email || '').toLowerCase().trim();
                const name = (user.name || '').toLowerCase().trim();
                const username = (user.username || '').toLowerCase().trim();

                // Designated Admins: Gunjan, Dhruvi, Aryan & Vardaan ALWAYS have full ADMIN powers!
                if (this.isDesignatedAdminUser(email, name, username)) {
                    return 'ADMIN';
                }

                // Verified DB admin role
                if (user.role === 'ADMIN') {
                    return 'ADMIN';
                }

                // Blocked from admin
                if (email === 'mahakkatahara.mk@gmail.com') {
                    return 'MEMBER';
                }

                if (email.endsWith('@mail.jiit.ac.in') || email.endsWith('@jiit.ac.in')) {
                    return 'MEMBER';
                }

                return 'MEMBER';
            } catch { }
        }

        const storedRole = localStorage.getItem('cicr_role');
        const authName = (localStorage.getItem('cicr_auth') || '').toLowerCase().trim();

        if (this.isDesignatedAdminUser(authName, authName, authName)) {
            return 'ADMIN';
        }

        if (storedRole === 'ADMIN') {
            return 'ADMIN';
        }

        return 'MEMBER';
    }

    private static isAdmin() {
        return this.getCurrentRole() === 'ADMIN';
    }

    private static setBorrowModalMode(_mode: 'borrow' | 'request', componentName: string, available: number) {
        const modalTitle = document.getElementById('borrow-form-title');
        const subtitle = document.getElementById('borrow-form-subtitle');
        const submitBtn = document.getElementById('borrow-form-submit') as HTMLButtonElement | null;
        const qtyLimit = document.getElementById('borrow-qty-limit');

        if (modalTitle) {
            modalTitle.innerText = 'Request Component Issue';
        }
        if (subtitle) {
            subtitle.innerText = `Requesting ${componentName} - Requires Admin Authorization`;
        }
        if (submitBtn) {
            submitBtn.innerText = 'Submit Issue Request';
        }
        if (qtyLimit) {
            qtyLimit.innerText = `Max units available: ${available}`;
        }
    }

    private static renderRequests() {
        const requestInbox = document.getElementById('request-inbox') as HTMLElement | null;
        const requestList = document.getElementById('request-list');
        const requestCountBadge = document.getElementById('request-count-badge');

        if (!requestInbox || !requestList || !requestCountBadge) return;

        if (!this.isAdmin()) {
            requestInbox.style.display = 'none';
            requestCountBadge.innerText = '0';
            return;
        }

        requestInbox.style.display = 'flex';
        const pendingRequests = requests.filter((request) => request.status === 'PENDING');
        requestCountBadge.innerText = String(pendingRequests.length);
        requestList.innerHTML = '';

        if (pendingRequests.length === 0) {
            requestList.innerHTML = '<div class="request-empty-state">No pending member requests right now.</div>';
            return;
        }

        pendingRequests.forEach((request) => {
            const requestEl = document.createElement('div');
            requestEl.className = 'request-item';
            requestEl.innerHTML = `
                <div class="request-item-header">
                    <div>
                        <h4 class="request-item-title">${request.itemName}</h4>
                        <div class="request-item-meta">
                            <span>${request.name}</span>
                            <span>${request.roll}</span>
                            <span>${request.qty} units</span>
                        </div>
                    </div>
                    <span class="request-status-chip request-status-pending">${request.status}</span>
                </div>
                <div class="request-item-meta">
                    <span>Purpose: ${request.purpose}</span>
                    <span>Requested: ${request.requestedAt}</span>
                </div>
                <div class="request-item-actions">
                    <button class="btn btn-primary request-approve-btn" data-request-id="${request.id}">
                        <i data-lucide="check"></i> Approve
                    </button>
                    <button class="btn btn-secondary request-reject-btn" data-request-id="${request.id}">
                        <i data-lucide="x"></i> Reject
                    </button>
                </div>
            `;

            requestList.appendChild(requestEl);
        });

        requestList.querySelectorAll('.request-approve-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const requestId = (button as HTMLButtonElement).dataset.requestId;
                if (requestId) {
                    this.reviewRequest(requestId, 'APPROVED');
                }
            });
        });

        requestList.querySelectorAll('.request-reject-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const requestId = (button as HTMLButtonElement).dataset.requestId;
                if (requestId) {
                    this.reviewRequest(requestId, 'REJECTED');
                }
            });
        });
    }

    public static reviewRequest(requestId: string, nextStatus: 'APPROVED' | 'REJECTED') {
        if (!this.isAdmin()) return;

        const request = requests.find((entry) => entry.id === requestId);
        if (!request || request.status !== 'PENDING') return;

        if (nextStatus === 'APPROVED') {
            const item = inventory.find((entry) => entry.id === request.itemId);
            const borrowedSum = item ? item.borrowedBy.reduce((sum, rec) => sum + rec.qty, 0) : 0;
            const available = item ? item.quantity - borrowedSum : 0;

            if (!item || available < request.qty) {
                request.status = 'REJECTED';
                request.reviewedAt = new Date().toISOString();
                request.reviewedBy = localStorage.getItem('cicr_auth') || 'ADMIN';
                request.reviewNote = 'Auto-rejected because stock was no longer available.';
                DatabaseManager.addLog('reject', `<span>${request.name}</span>'s request for <span>${request.itemName}</span> was rejected because stock ran out.`);
                DatabaseManager.save();
                this.renderRequests();
                this.renderLogsDrawer();
                if (selectedItem && selectedItem.id === request.itemId) {
                    this.openDetailModal(selectedItem);
                }
                window.dashboard?.init();
                return;
            }

            const defaultDueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            item.borrowedBy.push({
                name: request.name,
                roll: request.roll,
                qty: request.qty,
                purpose: request.purpose,
                date: new Date().toISOString().split('T')[0],
                dueDate: request.dueDate || defaultDueDate
            });

            DatabaseManager.addLog('approve', `<span>${request.name}</span>'s request for <span>${request.itemName}</span> was approved by admin.`);
            request.status = 'APPROVED';
        } else {
            DatabaseManager.addLog('reject', `<span>${request.name}</span>'s request for <span>${request.itemName}</span> was rejected by admin.`);
            request.status = 'REJECTED';
        }

        request.reviewedAt = new Date().toISOString();
        request.reviewedBy = localStorage.getItem('cicr_auth') || 'ADMIN';
        DatabaseManager.save();
        this.renderRequests();
        this.renderLogsDrawer();
        if (selectedItem && selectedItem.id === request.itemId) {
            this.openDetailModal(selectedItem);
        }
        window.dashboard?.init();
        lucide.createIcons();
    }

    static openAboutModal() {
        this.open('about-modal');
    }

    static openDetailModal(item: InventoryItem) {
        selectedItem = item;

        const borrowedSum = (item.borrowedBy || []).reduce((sum, rec) => sum + rec.qty, 0);
        const totalQty = Number(item.quantity) || 0;
        const available = typeof item.availableQuantity === 'number'
            ? Math.min(totalQty, Math.max(0, item.availableQuantity))
            : Math.max(0, totalQty - borrowedSum);

        document.getElementById('detail-name')!.innerText = item.name;
        document.getElementById('detail-location')!.innerText = item.location;
        document.getElementById('detail-specs')!.innerText = item.specs;
        document.getElementById('detail-quantity')!.innerHTML = `<strong>${available}</strong> / ${totalQty} available`;

        const catMap: Record<string, string> = {
            microcontrollers: "Microcontroller / Development Board",
            sensors: "Sensor & Module",
            actuators: "Actuator & Driver",
            power: "Power & Battery Storage",
            tools: "Lab Equipment / Tool"
        };
        document.getElementById('detail-category')!.innerText = catMap[item.category] || item.category;

        const badge = document.getElementById('detail-status')!;
        badge.className = 'modal-status-badge';

        const borrowBtn = document.getElementById('btn-borrow') as HTMLButtonElement;
        const returnBtn = document.getElementById('btn-return') as HTMLButtonElement;
        const role = this.getCurrentRole();

        const status = getItemStockStatus(totalQty, available);
        badge.innerText = status.text;
        badge.className = `modal-status-badge ${status.class}`;

        if (available > 0) {
            borrowBtn.disabled = false;
            borrowBtn.style.opacity = '1';
        } else {
            borrowBtn.disabled = true;
            borrowBtn.style.opacity = '0.5';
        }

        const myLoans = (item.borrowedBy || []).filter(rec => !rec.returned && ModalManager.isUserLoanMatch(rec));
        const myActiveLoan = myLoans.find(r => (r as any).status !== 'RETURN_REQUESTED') || myLoans[0];
        const anyActiveLoan = (item.borrowedBy || []).find(rec => !rec.returned);
        const targetLoan = myActiveLoan || (role === 'ADMIN' ? anyActiveLoan : null);

        // Display Return Issued Component button
        if (targetLoan) {
            const isPendingReturn = (targetLoan as any).status === 'RETURN_REQUESTED';
            returnBtn.style.display = 'inline-flex';
            if (isPendingReturn) {
                returnBtn.disabled = true;
                returnBtn.style.opacity = '0.75';
                returnBtn.style.cursor = 'not-allowed';
                returnBtn.innerHTML = '<i data-lucide="clock"></i> Return Pending Admin Verification';
                returnBtn.onclick = null;
            } else {
                returnBtn.disabled = false;
                returnBtn.style.opacity = '1';
                returnBtn.style.cursor = 'pointer';
                returnBtn.innerHTML = '<i data-lucide="corner-up-left"></i> Return Component';
                returnBtn.onclick = () => {
                    this.openReturnModal(targetLoan, item, item.borrowedBy.indexOf(targetLoan));
                };
            }
        } else {
            returnBtn.style.display = 'none';
        }

        const bulkReturnBtn = document.getElementById('btn-modal-bulk-return') as HTMLButtonElement | null;
        if (bulkReturnBtn) {
            let hasActiveLoans = false;
            for (const it of inventory) {
                if ((it.borrowedBy || []).some(r => !r.returned && (r as any).status !== 'RETURN_REQUESTED' && ModalManager.isUserLoanMatch(r))) {
                    hasActiveLoans = true;
                    break;
                }
            }
            if (hasActiveLoans) {
                bulkReturnBtn.style.display = 'inline-flex';
                bulkReturnBtn.onclick = () => {
                    this.closeAll();
                    this.openBulkReturnModal();
                };
            } else {
                bulkReturnBtn.style.display = 'none';
            }
        }

        const deleteItemBtn = document.getElementById('btn-modal-delete-item') as HTMLButtonElement;
        if (deleteItemBtn) {
            deleteItemBtn.style.display = role === 'ADMIN' ? 'inline-flex' : 'none';
            deleteItemBtn.onclick = () => {
                ModalManager.closeAll();
                AdminManager.promptDeleteItem(item.id, item.name);
            };
        }

        if (role === 'ADMIN') {
            borrowBtn.innerHTML = '<i data-lucide="shopping-cart"></i> Checkout / Borrow';
        } else {
            borrowBtn.innerHTML = '<i data-lucide="send"></i> Request Issue';
        }

        const borrowersPanel = document.getElementById('borrowers-panel')!;
        const listContainer = document.getElementById('borrowers-list')!;
        listContainer.innerHTML = '';

        const isMember = role !== 'ADMIN';
        const visibleBorrowers = isMember
            ? (item.borrowedBy || []).filter(rec => !rec.returned && ModalManager.isUserLoanMatch(rec))
            : (item.borrowedBy || []).filter(rec => !rec.returned);

        if (visibleBorrowers.length > 0) {
            borrowersPanel.style.display = 'block';
            const todayStr = new Date().toISOString().split('T')[0];

            visibleBorrowers.forEach((rec) => {
                const origIdx = item.borrowedBy.indexOf(rec);
                let due = rec.dueDate;
                if (!due && rec.date) {
                    const bTime = new Date(rec.date).getTime();
                    if (!isNaN(bTime)) {
                        due = new Date(bTime + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    }
                }
                const isOverdue = Boolean(due && due < todayStr);
                const dueBadge = due ? `<span class="borrower-due-badge ${isOverdue ? 'overdue' : ''}">${isOverdue ? 'OVERDUE: ' : 'Due: '}${due}</span>` : '';

                const isMyRecord = ModalManager.isUserLoanMatch(rec);
                const canReturn = isMyRecord || role === 'ADMIN';
                const isRecPendingReturn = (rec as any).status === 'RETURN_REQUESTED';
                const statusBadge = isRecPendingReturn
                    ? `<span class="borrower-due-badge" style="background:rgba(255,183,3,0.15);color:#ffb703;border:1px solid rgba(255,183,3,0.3);"><i data-lucide="clock" style="width:11px;height:11px;vertical-align:middle;"></i> Awaiting Verification</span>`
                    : dueBadge;

                const recEl = document.createElement('div');
                recEl.className = 'borrower-record';
                recEl.innerHTML = `
                    <div class="borrower-info-main">
                        <span class="borrower-name">${rec.name} ${isMyRecord ? '(Your Active Loan)' : ''}</span>
                        <span class="borrower-roll">${rec.roll} &bull; ${rec.purpose}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        ${statusBadge}
                        <span class="borrower-qty-badge">${rec.qty} units</span>
                        ${canReturn ? (
                        isRecPendingReturn
                            ? `<button class="btn btn-secondary" disabled style="padding: 6px 10px; font-size: 11px; opacity: 0.6; cursor: not-allowed;"><i data-lucide="clock" style="width:12px;height:12px;"></i> Verification Pending</button>`
                            : `<button class="btn btn-secondary btn-inline-return" style="padding: 6px 10px; font-size: 11px;"><i data-lucide="corner-up-left" style="width:12px;height:12px;"></i> Return</button>`
                    ) : ''}
                    </div>
                `;

                if (canReturn && !isRecPendingReturn) {
                    recEl.querySelector('.btn-inline-return')?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openReturnModal(rec, item, origIdx);
                    });
                }

                listContainer.appendChild(recEl);
            });
        } else {
            borrowersPanel.style.display = 'none';
        }

        this.open('detail-modal');
        lucide.createIcons();
    }

    static openBorrowFormModal() {
        if (!selectedItem) return;

        const borrowedSum = (selectedItem.borrowedBy || []).reduce((sum, rec) => sum + rec.qty, 0);
        const available = typeof selectedItem.availableQuantity === 'number'
            ? selectedItem.availableQuantity
            : Math.max(0, selectedItem.quantity - borrowedSum);

        this.setBorrowModalMode('request', selectedItem.name, available);

        // Auto-fill logged-in borrower details
        let currentUserName = '';
        let currentUserRoll = '';
        try {
            const userStr = localStorage.getItem('cicr_user');
            if (userStr) {
                const parsed = JSON.parse(userStr);
                currentUserName = parsed.name || parsed.username || '';
                currentUserRoll = parsed.roll_number || parsed.roll || '';
                if (!currentUserRoll && parsed.email) {
                    const match = String(parsed.email).match(/^([0-9]{6,12})@/);
                    if (match) currentUserRoll = match[1];
                }
            }
        } catch { }

        if (!currentUserName) {
            currentUserName = localStorage.getItem('cicr_auth') || '';
        }

        if (!currentUserName) {
            const profileDisplay = document.getElementById('profile-username-display');
            if (profileDisplay && profileDisplay.innerText.trim()) {
                currentUserName = profileDisplay.innerText.trim();
            }
        }

        if (!currentUserRoll && currentUserName) {
            const match = currentUserName.match(/^([0-9]{6,12})$/);
            if (match) currentUserRoll = match[1];
        }

        const nameInput = document.getElementById('borrow-name') as HTMLInputElement | null;
        if (nameInput) {
            nameInput.value = currentUserName || '';
            nameInput.defaultValue = currentUserName || '';
            nameInput.readOnly = true;
            nameInput.setAttribute('tabindex', '-1');
            nameInput.title = 'Verified account identity (locked)';
        }

        const rollInput = document.getElementById('borrow-roll') as HTMLInputElement | null;
        if (rollInput) {
            rollInput.value = currentUserRoll || '';
            rollInput.defaultValue = currentUserRoll || '';
            if (currentUserRoll) {
                rollInput.readOnly = true;
                rollInput.setAttribute('tabindex', '-1');
                rollInput.title = 'Verified student enrollment ID (locked)';
            } else {
                rollInput.readOnly = false;
                rollInput.removeAttribute('tabindex');
                rollInput.title = 'Enter your enrollment ID';
            }
        }

        const qtyInput = document.getElementById('borrow-qty') as HTMLInputElement;
        qtyInput.max = String(available);
        qtyInput.value = '1';

        const dueDateInput = document.getElementById('borrow-due-date') as HTMLInputElement | null;
        if (dueDateInput) {
            const today = new Date().toISOString().split('T')[0];
            const defaultDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            dueDateInput.min = today;
            dueDateInput.value = defaultDue;
        }

        this.close('detail-modal');
        this.open('borrow-form-modal');
    }

    static activeNotifTab: string = 'return';

    static openLogsDrawer() {
        this.renderLogsDrawer();
        this.open('logs-drawer');
        lucide.createIcons();
    }

    static renderLogsDrawer() {
        const logsList = document.getElementById('logs-list');
        if (!logsList) return;

        const role = this.getCurrentRole();
        const isAdmin = role === 'ADMIN';

        const storedUser = JSON.parse(localStorage.getItem('cicr_user') || '{}');
        const authName = (localStorage.getItem('cicr_auth') || '').toLowerCase().trim();
        const userName = (storedUser.name || '').toLowerCase().trim();
        const userEmail = (storedUser.email || '').toLowerCase().trim();
        const userRoll = (storedUser.roll_number || storedUser.roll || '').toLowerCase().trim();

        const isUserLoan = (rec: BorrowRecord) => ModalManager.isUserLoanMatch(rec);

        const isUserRequest = (req: any) => {
            const rName = (req.name || req.borrowerName || '').toLowerCase().trim();
            const rRoll = (req.roll || req.rollNumber || '').toLowerCase().trim();
            const rEmail = (req.email || req.borrowerEmail || '').toLowerCase().trim();
            if (userRoll && rRoll && rRoll === userRoll) return true;
            if (userEmail && rEmail && rEmail === userEmail) return true;
            if (userName && rName && (rName === userName || rName.includes(userName) || userName.includes(rName))) return true;
            if (authName && (rName === authName || rEmail === authName)) return true;
            return false;
        };

        // Update Header Badge and Subtitle
        const roleBadgeEl = document.getElementById('notif-drawer-role-badge');
        const roleDotEl = document.getElementById('notif-role-dot');
        const roleTextEl = document.getElementById('notif-role-text');
        const subtitleEl = document.getElementById('notif-drawer-subtitle');

        if (isAdmin) {
            if (roleBadgeEl) {
                roleBadgeEl.classList.remove('role-badge-member');
                roleBadgeEl.classList.add('role-badge-admin');
            }
            if (roleDotEl) {
                roleDotEl.classList.remove('dot-member');
                roleDotEl.classList.add('dot-admin');
            }
            if (roleTextEl) roleTextEl.innerText = 'ADMIN TELEMETRY';
            if (subtitleEl) subtitleEl.innerText = 'Operational alerts, loan schedules & system updates';
        } else {
            if (roleBadgeEl) {
                roleBadgeEl.classList.remove('role-badge-admin');
                roleBadgeEl.classList.add('role-badge-member');
            }
            if (roleDotEl) {
                roleDotEl.classList.remove('dot-admin');
                roleDotEl.classList.add('dot-member');
            }
            if (roleTextEl) roleTextEl.innerText = 'MEMBER ACCESS';
            if (subtitleEl) subtitleEl.innerText = 'Your active loans, request status & lab updates';
        }

        // Segmented Category Tabs setup: stock tab is admin-only
        const stockTabBtn = document.getElementById('notif-tab-stock');
        if (stockTabBtn) {
            stockTabBtn.style.display = isAdmin ? 'inline-flex' : 'none';
        }

        // If regular member is on 'stock' tab or invalid tab, redirect to 'return'
        if ((!isAdmin && this.activeNotifTab === 'stock') || this.activeNotifTab === 'all') {
            this.activeNotifTab = 'return';
        }

        // Setup tab click listeners once
        const tabsBar = document.getElementById('notif-tabs-bar');
        if (tabsBar && !tabsBar.dataset.bound) {
            tabsBar.dataset.bound = 'true';
            tabsBar.querySelectorAll<HTMLButtonElement>('.notif-tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const cat = btn.getAttribute('data-category') || 'return';
                    ModalManager.activeNotifTab = cat;
                    ModalManager.renderLogsDrawer();
                    lucide.createIcons();
                });
            });
        }

        // Setup Mark All Read button
        const clearBtn = document.getElementById('notif-clear-all-btn');
        if (clearBtn && !clearBtn.dataset.bound) {
            clearBtn.dataset.bound = 'true';
            clearBtn.addEventListener('click', () => {
                DatabaseManager.isNotificationsCleared = true;
                DatabaseManager.updateNotificationBadges();
                ToastManager.show('Notifications Cleared', 'All current alerts marked as read.', 'info');
            });
        }

        // Highlight active tab button
        if (tabsBar) {
            tabsBar.querySelectorAll('.notif-tab-btn').forEach(btn => {
                const cat = btn.getAttribute('data-category');
                btn.classList.toggle('active', cat === this.activeNotifTab);
            });
        }

        // --- 1. GATHER RETURNS DATA ---
        const todayStr = new Date().toISOString().split('T')[0];
        const overdueLoans: { item: InventoryItem; rec: BorrowRecord; due: string }[] = [];
        const activeLoans: { item: InventoryItem; rec: BorrowRecord; due: string }[] = [];

        inventory.forEach((item) => {
            (item.borrowedBy || []).forEach((rec) => {
                if (rec.returned) return;

                const belongsToUser = isUserLoan(rec);
                if (!isAdmin && !belongsToUser) return;

                let due = rec.dueDate;
                if (!due && rec.date) {
                    const bTime = new Date(rec.date).getTime();
                    if (!isNaN(bTime)) {
                        due = new Date(bTime + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                    }
                }

                if (due && due < todayStr) {
                    overdueLoans.push({ item, rec, due: due || 'Overdue' });
                } else {
                    activeLoans.push({ item, rec, due: due || 'Standard (7d)' });
                }
            });
        });

        // --- 2. GATHER STOCK DATA (Admin only) ---
        const lowStockList: InventoryItem[] = [];
        if (isAdmin) {
            inventory.forEach((item) => {
                const total = Number(item.quantity) || 0;
                const available = typeof item.availableQuantity === 'number'
                    ? item.availableQuantity
                    : total;
                const isDepleted = (available <= 0 && total > 0) || (total >= 3 && available <= 1) || (total <= 2 && available < total);
                if (isDepleted) {
                    lowStockList.push(item);
                }
            });
        }

        // --- 3. GATHER REQUESTS DATA ---
        const combinedRequests: (RequestRecord | AdminHardwareRequest)[] = [];
        const seenDrawerReqKeys = new Set<string>();

        const getDrawerKey = (r: any): string => {
            if (typeof AdminManager !== 'undefined' && typeof AdminManager.getRequestCanonicalKey === 'function') {
                return AdminManager.getRequestCanonicalKey(r);
            }
            const isReturn = r.type === 'RETURN' || Boolean(r.borrowId);
            if (isReturn) return `ret__${(r.borrowId || r.id || '').trim()}`;
            const email = (r.borrowerEmail || r.email || '').toLowerCase().trim();
            const name = (r.borrowerName || r.name || '').toLowerCase().trim();
            const itemId = (r.itemId || '').toLowerCase().trim();
            const qty = Number(r.quantity || r.qty) || 1;
            const purp = (r.purpose || '').toLowerCase().trim();
            const reqTime = r.requestedAt ? new Date(r.requestedAt).getTime() : 0;
            const timeBucket = reqTime > 0 ? Math.floor(reqTime / 120000) : 0;
            return `iss__${email}__${name}__${itemId}__${qty}__${purp}__${timeBucket}`;
        };

        const handledIds = typeof AdminManager !== 'undefined' ? AdminManager.getHandledRequestIds() : new Set<string>();

        const isDrawerItemDismissed = (r: any): boolean => {
            if (!r) return true;
            if (handledIds.has(r.id)) return true;
            if (r.borrowId && handledIds.has(r.borrowId)) return true;
            const key = getDrawerKey(r);
            if (key && handledIds.has(key)) return true;
            return false;
        };

        if (typeof AdminManager !== 'undefined' && Array.isArray(AdminManager.hardwareRequests)) {
            AdminManager.hardwareRequests.forEach(r => {
                if (r && !isDrawerItemDismissed(r)) {
                    const key = getDrawerKey(r);
                    if (!seenDrawerReqKeys.has(key) && !seenDrawerReqKeys.has(r.id)) {
                        seenDrawerReqKeys.add(key);
                        seenDrawerReqKeys.add(r.id);
                        combinedRequests.push(r);
                    }
                }
            });
        }

        (requests || []).forEach(r => {
            if (r && !isDrawerItemDismissed(r)) {
                const key = getDrawerKey(r);
                if (!seenDrawerReqKeys.has(key) && !seenDrawerReqKeys.has(r.id)) {
                    seenDrawerReqKeys.add(key);
                    seenDrawerReqKeys.add(r.id);
                    combinedRequests.push(r);
                }
            }
        });

        const visibleRequests: any[] = isAdmin
            ? combinedRequests.filter(r => r.status === 'PENDING')
            : combinedRequests.filter(r => isUserRequest(r));

        // --- 4. GATHER SYSTEM LOGS DATA ---
        const visibleLogs: ActivityLog[] = isAdmin
            ? [...logs]
            : logs.filter(l => l.type === 'add' || l.type === 'system' || (userName && l.text.toLowerCase().includes(userName)));

        // --- UPDATE BADGE COUNTS ON TABS ---
        const totalReturnsCount = overdueLoans.length + activeLoans.length;
        const totalStockCount = lowStockList.length;
        const totalRequestsCount = visibleRequests.length;
        const totalSystemCount = visibleLogs.length;

        const countReturn = document.getElementById('notif-count-return');
        const countStock = document.getElementById('notif-count-stock');
        const countRequests = document.getElementById('notif-count-requests');
        const countSystem = document.getElementById('notif-count-system');

        if (countReturn) countReturn.innerText = String(totalReturnsCount);
        if (countStock) countStock.innerText = String(totalStockCount);
        if (countRequests) countRequests.innerText = String(totalRequestsCount);
        if (countSystem) countSystem.innerText = String(totalSystemCount);

        // Synchronize sidebar and topbar badges as well
        DatabaseManager.updateNotificationBadges();

        // --- RENDER CONTENT BASED ON ACTIVE TAB ---
        logsList.innerHTML = '';
        const currentCategory = this.activeNotifTab;

        // Render functions for each category
        const renderReturnsSection = (container: HTMLElement) => {
            if (overdueLoans.length === 0 && activeLoans.length === 0) {
                container.appendChild(ModalManager.createEmptyNotifCard('rotate-ccw', 'No Return Due Schedules', isAdmin ? 'All borrowed components have been returned on schedule.' : 'You have no active loans or overdue components checked out.'));
                return;
            }

            // Overdue section
            if (overdueLoans.length > 0) {
                const secHeader = document.createElement('div');
                secHeader.className = 'notif-section-header header-return';
                secHeader.innerHTML = `
                    <div class="sec-header-left">
                        <i data-lucide="alert-triangle"></i>
                        <span>OVERDUE RETURNS</span>
                    </div>
                    <span class="sec-header-badge badge-red">${overdueLoans.length} CRITICAL</span>
                `;
                container.appendChild(secHeader);

                overdueLoans.forEach(({ item, rec, due }) => {
                    const el = document.createElement('div');
                    el.className = 'notif-card card-return card-overdue';
                    const dt = DashboardManager.formatLogDateTime(due);
                    const isMyRecord = ModalManager.isUserLoanMatch(rec);
                    el.innerHTML = `
                        <div class="notif-card-header">
                            <div class="notif-card-tag tag-red">
                                <i data-lucide="clock-alert"></i>
                                <span>OVERDUE</span>
                            </div>
                            <span class="notif-card-due text-red">Due: ${dt.dateStr}</span>
                        </div>
                        <div class="notif-card-body">
                            <p class="notif-card-main-text">
                                <strong>${rec.qty}x ${item.name}</strong> was borrowed by <span class="notif-user-pill">${rec.name}</span> (${rec.roll || 'Student'}).
                            </p>
                            <p class="notif-card-sub-text">Purpose: ${rec.purpose || 'Lab Project'} &bull; Due date was ${due}. Immediate return required.</p>
                            ${isMyRecord ? `
                            <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                <button class="btn btn-secondary btn-drawer-return" style="padding: 4px 10px; font-size: 11px; display:inline-flex; align-items:center; gap:5px;">
                                    <i data-lucide="corner-up-left" style="width:12px;height:12px;"></i> Return
                                </button>
                            </div>
                            ` : ''}
                        </div>
                    `;
                    if (isMyRecord) {
                        el.querySelector('.btn-drawer-return')?.addEventListener('click', (e) => {
                            e.stopPropagation();
                            ModalManager.close('logs-drawer');
                            const origIdx = (item.borrowedBy || []).indexOf(rec);
                            ModalManager.openReturnModal(rec, item, origIdx >= 0 ? origIdx : 0);
                        });
                    }
                    container.appendChild(el);
                });
            }

            // Active loans section
            if (activeLoans.length > 0) {
                const myActiveLoans = activeLoans.filter(l => ModalManager.isUserLoanMatch(l.rec) && (l.rec as any).status !== 'RETURN_REQUESTED');
                if (myActiveLoans.length > 0) {
                    const bannerEl = document.createElement('div');
                    bannerEl.className = 'drawer-bulk-return-banner';
                    bannerEl.innerHTML = `
                        <div class="banner-text-col">
                            <div class="banner-title"><i data-lucide="layers"></i> CONSOLIDATED RETURN</div>
                            <div class="banner-desc">You hold ${myActiveLoans.length} active checkout schedule(s). Return all or select quantities in 1 go.</div>
                        </div>
                        <button class="btn btn-primary btn-sm btn-drawer-bulk-return" id="btn-drawer-bulk-return">
                            <i data-lucide="corner-up-left"></i> Return in 1 Go
                        </button>
                    `;
                    bannerEl.querySelector('#btn-drawer-bulk-return')?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        ModalManager.close('logs-drawer');
                        ModalManager.openBulkReturnModal();
                    });
                    container.appendChild(bannerEl);
                }

                const secHeader = document.createElement('div');
                secHeader.className = 'notif-section-header header-loans';
                secHeader.innerHTML = `
                    <div class="sec-header-left">
                        <i data-lucide="shopping-cart"></i>
                        <span>ACTIVE LOAN SCHEDULES</span>
                    </div>
                    <span class="sec-header-badge badge-cyan">${activeLoans.length} ACTIVE</span>
                `;
                container.appendChild(secHeader);

                activeLoans.forEach(({ item, rec, due }) => {
                    const el = document.createElement('div');
                    el.className = 'notif-card card-loan';
                    const dt = DashboardManager.formatLogDateTime(due);
                    const isMyRecord = ModalManager.isUserLoanMatch(rec);
                    el.innerHTML = `
                        <div class="notif-card-header">
                            <div class="notif-card-tag tag-cyan">
                                <i data-lucide="shopping-cart"></i>
                                <span>ACTIVE LOAN</span>
                            </div>
                            <span class="notif-card-due text-cyan">Due: ${dt.dateStr}</span>
                        </div>
                        <div class="notif-card-body">
                            <p class="notif-card-main-text">
                                <strong>${rec.qty}x ${item.name}</strong> &bull; Held by <span class="notif-user-pill">${rec.name}</span> (${rec.roll || 'ID'})
                            </p>
                            <p class="notif-card-sub-text">Purpose: ${rec.purpose || 'Robotics Work'}</p>
                            ${isMyRecord ? `
                            <div style="display:flex; justify-content:flex-end; margin-top:8px;">
                                <button class="btn btn-secondary btn-drawer-return" style="padding: 4px 10px; font-size: 11px; display:inline-flex; align-items:center; gap:5px;">
                                    <i data-lucide="corner-up-left" style="width:12px;height:12px;"></i> Return
                                </button>
                            </div>
                            ` : ''}
                        </div>
                    `;
                    if (isMyRecord) {
                        el.querySelector('.btn-drawer-return')?.addEventListener('click', (e) => {
                            e.stopPropagation();
                            ModalManager.close('logs-drawer');
                            const origIdx = (item.borrowedBy || []).indexOf(rec);
                            ModalManager.openReturnModal(rec, item, origIdx >= 0 ? origIdx : 0);
                        });
                    }
                    container.appendChild(el);
                });
            }
        };

        const renderStockSection = (container: HTMLElement) => {
            if (!isAdmin) {
                container.appendChild(ModalManager.createEmptyNotifCard('shield-alert', 'Restricted Section', 'Warehouse stock reserve telemetry is only accessible to Administrators.'));
                return;
            }

            if (lowStockList.length === 0) {
                container.appendChild(ModalManager.createEmptyNotifCard('boxes', 'Stock Levels Healthy', 'All vaulted components have sufficient reserves above threshold.'));
                return;
            }

            const secHeader = document.createElement('div');
            secHeader.className = 'notif-section-header header-stock';
            secHeader.innerHTML = `
                <div class="sec-header-left">
                    <i data-lucide="alert-circle"></i>
                    <span>STOCK & WAREHOUSE RESERVES</span>
                </div>
                <span class="sec-header-badge badge-yellow">${lowStockList.length} LOW</span>
            `;
            container.appendChild(secHeader);

            lowStockList.forEach(item => {
                const el = document.createElement('div');
                el.className = 'notif-card card-stock';
                const borrowedSum = (item.borrowedBy || []).reduce((sum, rec) => sum + rec.qty, 0);
                const totalQty = Number(item.quantity) || 0;
                const avail = typeof item.availableQuantity === 'number'
                    ? Math.min(totalQty, Math.max(0, item.availableQuantity))
                    : Math.max(0, totalQty - borrowedSum);
                el.innerHTML = `
                    <div class="notif-card-header">
                        <div class="notif-card-tag tag-yellow">
                            <i data-lucide="alert-circle"></i>
                            <span>LOW RESERVES</span>
                        </div>
                        <span class="notif-card-location"><i data-lucide="map-pin"></i> ${item.location || 'Warehouse'}</span>
                    </div>
                    <div class="notif-card-body">
                        <p class="notif-card-main-text">
                            Component <strong>${item.name}</strong> is critically low.
                        </p>
                        <p class="notif-card-sub-text">
                            Available: <strong class="text-yellow">${avail}</strong> / ${totalQty} total &bull; Category: ${item.category}
                        </p>
                    </div>
                `;
                container.appendChild(el);
            });
        };

        const renderRequestsSection = (container: HTMLElement) => {
            if (visibleRequests.length === 0) {
                container.appendChild(ModalManager.createEmptyNotifCard('send', 'No Hardware Requisitions', isAdmin ? 'No component issue requests submitted by members.' : 'You have not submitted any hardware issue requests yet.'));
                return;
            }

            const secHeader = document.createElement('div');
            secHeader.className = 'notif-section-header header-requests';
            const pendingCount = visibleRequests.filter(r => r.status === 'PENDING').length;
            secHeader.innerHTML = `
                <div class="sec-header-left">
                    <i data-lucide="send"></i>
                    <span>HARDWARE ISSUE REQUESTS</span>
                </div>
                <span class="sec-header-badge ${pendingCount > 0 ? 'badge-yellow' : 'badge-cyan'}">${pendingCount} PENDING</span>
            `;
            container.appendChild(secHeader);

            visibleRequests.forEach(req => {
                const el = document.createElement('div');
                el.className = `notif-card card-request card-request-${(req.status || 'PENDING').toLowerCase()}`;

                let statusBadge = '';
                if (req.status === 'APPROVED') {
                    statusBadge = `<span class="notif-status-badge badge-green"><i data-lucide="check-circle-2"></i> APPROVED</span>`;
                } else if (req.status === 'REJECTED') {
                    statusBadge = `<span class="notif-status-badge badge-red"><i data-lucide="x-circle"></i> REJECTED</span>`;
                } else {
                    statusBadge = `<span class="notif-status-badge badge-yellow"><i data-lucide="clock"></i> PENDING REVIEW</span>`;
                }

                const actionsHtml = (isAdmin && req.status === 'PENDING') ? `
                    <div class="notif-card-actions">
                        <button class="notif-action-btn notif-btn-approve" data-req-id="${req.id}">
                            <i data-lucide="check"></i> Approve
                        </button>
                        <button class="notif-action-btn notif-btn-reject" data-req-id="${req.id}">
                            <i data-lucide="x"></i> Reject
                        </button>
                    </div>
                ` : '';

                const bName = (req as any).borrowerName || (req as any).name || 'Member';
                const bRoll = (req as any).rollNumber || (req as any).roll || 'Student';
                const bQty = (req as any).quantity || (req as any).qty || 1;

                el.innerHTML = `
                    <div class="notif-card-header">
                        <div class="notif-card-tag tag-purple">
                            <i data-lucide="send"></i>
                            <span>REQUEST #${req.id.slice(-5)}</span>
                        </div>
                        ${statusBadge}
                    </div>
                    <div class="notif-card-body">
                        <p class="notif-card-main-text">
                            <strong>${bQty}x ${req.itemName}</strong> requested by <span class="notif-user-pill">${bName}</span> (${bRoll})
                        </p>
                        <p class="notif-card-sub-text">
                            Purpose: ${req.purpose || 'Project'} &bull; Requested on: ${req.requestedAt ? new Date(req.requestedAt).toLocaleDateString() : 'Recent'}
                            ${req.dueDate ? ` &bull; Expected Return: ${req.dueDate}` : ''}
                        </p>
                    </div>
                    ${actionsHtml}
                `;

                container.appendChild(el);
            });

            // Bind inline action buttons for admin
            if (isAdmin) {
                container.querySelectorAll<HTMLButtonElement>('.notif-btn-approve').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const reqId = btn.getAttribute('data-req-id');
                        if (reqId) {
                            if (typeof AdminManager !== 'undefined' && typeof AdminManager.approveHardware === 'function') {
                                await AdminManager.approveHardware(reqId);
                            } else {
                                ModalManager.reviewRequest(reqId, 'APPROVED');
                            }
                            DatabaseManager.isNotificationsCleared = false;
                            DatabaseManager.updateNotificationBadges();
                            ModalManager.renderLogsDrawer();
                        }
                    });
                });
                container.querySelectorAll<HTMLButtonElement>('.notif-btn-reject').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const reqId = btn.getAttribute('data-req-id');
                        if (reqId) {
                            if (typeof AdminManager !== 'undefined' && typeof AdminManager.rejectHardware === 'function') {
                                await AdminManager.rejectHardware(reqId);
                            } else {
                                ModalManager.reviewRequest(reqId, 'REJECTED');
                            }
                            DatabaseManager.isNotificationsCleared = false;
                            DatabaseManager.updateNotificationBadges();
                            ModalManager.renderLogsDrawer();
                        }
                    });
                });
            }
        };

        const renderSystemSection = (container: HTMLElement) => {
            const hasBackendLogs = typeof AdminManager !== 'undefined' && Array.isArray(AdminManager.auditLogs) && AdminManager.auditLogs.length > 0;
            const logSource = hasBackendLogs ? AdminManager.auditLogs : visibleLogs;

            if (logSource.length === 0) {
                container.appendChild(ModalManager.createEmptyNotifCard('terminal', 'No 7-Day Activity Recorded', 'Centralized 7-day audit records will stream here as events occur.'));
                return;
            }

            const secHeader = document.createElement('div');
            secHeader.className = 'notif-section-header header-system';
            secHeader.innerHTML = `
                <div class="sec-header-left">
                    <i data-lucide="terminal"></i>
                    <span>7-DAY SYSTEM TELEMETRY & AUDIT LEDGER</span>
                </div>
                <span class="sec-header-badge badge-purple">${logSource.length} EVENTS</span>
            `;
            container.appendChild(secHeader);

            if (hasBackendLogs) {
                const sortedLogs = AdminManager.auditLogs.slice(0, 40);
                sortedLogs.forEach(log => {
                    const el = document.createElement('div');
                    const act = log.action || 'Event';
                    let badgeClass = 'action-cyan';
                    let iconName = 'activity';

                    if (['Item Added', 'Hardware Approved', 'User Approved', 'Returned', 'Item Returned'].includes(act)) {
                        badgeClass = 'action-green';
                        iconName = 'check-circle';
                    } else if (['Item Deleted', 'Hardware Rejected', 'User Rejected', 'User Deleted'].includes(act)) {
                        badgeClass = 'action-red';
                        iconName = 'alert-octagon';
                    } else if (['Sign In', 'Sign Up', 'Role Changed', 'Password Reset'].includes(act)) {
                        badgeClass = 'action-purple';
                        iconName = act === 'Sign In' ? 'log-in' : 'user-plus';
                    } else if (['Borrowed', 'Item Borrowed', 'Hardware Requested'].includes(act)) {
                        badgeClass = 'action-yellow';
                        iconName = 'package';
                    }

                    const rawTime = log.timestamp || log.created_at || new Date().toISOString();
                    const dt = DashboardManager.formatLogDateTime(rawTime);
                    const timeAgo = AdminManager.formatTimeAgo(rawTime);
                    const actorName = log.users?.name || (log.user_id ? 'Member' : 'System');

                    el.className = 'notif-card card-loan';
                    el.style.cursor = 'pointer';
                    el.onclick = () => {
                        if (typeof AdminManager.openAuditDetail === 'function') {
                            AdminManager.openAuditDetail(log.id);
                        }
                    };
                    el.innerHTML = `
                        <div class="notif-card-header">
                            <div class="notif-card-tag ${badgeClass === 'action-green' ? 'tag-green' : badgeClass === 'action-red' ? 'tag-red' : badgeClass === 'action-purple' ? 'tag-purple' : 'tag-cyan'}">
                                <i data-lucide="${iconName}"></i>
                                <span>${act.toUpperCase()}</span>
                            </div>
                            <span class="notif-card-due text-cyan">${timeAgo}</span>
                        </div>
                        <div class="notif-card-body">
                            <p class="notif-card-main-text">${AdminManager.escapeHtml(log.description || act)}</p>
                            <p class="notif-card-sub-text">Actor: <strong>${actorName}</strong> &bull; ${dt.dateStr} ${dt.timeStr}</p>
                        </div>
                    `;
                    container.appendChild(el);
                });
            } else {
                // Fallback to local logs
                const sortedLogs = [...visibleLogs].reverse().slice(0, 30);
                sortedLogs.forEach(log => {
                    const el = document.createElement('div');
                    el.className = `log-item log-action-${log.type}`;
                    let icon = 'info';
                    let label = log.type.toUpperCase();

                    if (log.type === 'borrow') { icon = 'shopping-cart'; label = 'BORROW'; }
                    else if (log.type === 'return') { icon = 'corner-up-left'; label = 'RETURNED'; }
                    else if (log.type === 'overdue') { icon = 'clock-alert'; label = 'OVERDUE'; }
                    else if (log.type === 'low_stock') { icon = 'alert-circle'; label = 'LOW STOCK'; }
                    else if (log.type === 'add') { icon = 'plus'; label = 'NEW COMPONENT'; }
                    else if (log.type === 'system') { icon = 'terminal'; label = 'SYSTEM'; }
                    else if (log.type === 'request') { icon = 'send'; label = 'REQUEST'; }
                    else if (log.type === 'approve') { icon = 'check'; label = 'APPROVED'; }
                    else if (log.type === 'reject') { icon = 'x'; label = 'REJECTED'; }

                    const dt = DashboardManager.formatLogDateTime(log.timestamp);
                    el.innerHTML = `
                        <div class="log-meta">
                            <span class="log-type-tag"><i data-lucide="${icon}"></i> ${label}</span>
                            <div class="log-timestamp-stack">
                                <span class="log-date-line">${dt.dateStr}</span>
                                ${dt.timeStr ? `<span class="log-time-line">${dt.timeStr}</span>` : ''}
                            </div>
                        </div>
                        <div class="log-text-content">${log.text}</div>
                    `;
                    container.appendChild(el);
                });
            }
        };

        if (currentCategory === 'return') {
            renderReturnsSection(logsList);
        } else if (currentCategory === 'stock') {
            renderStockSection(logsList);
        } else if (currentCategory === 'requests') {
            renderRequestsSection(logsList);
        } else if (currentCategory === 'system') {
            renderSystemSection(logsList);
        } else {
            renderReturnsSection(logsList);
        }
    }

    private static createEmptyNotifCard(icon: string, title: string, desc: string): HTMLElement {
        const div = document.createElement('div');
        div.className = 'notif-empty-state';
        div.innerHTML = `
            <div class="notif-empty-icon-box">
                <i data-lucide="${icon}"></i>
            </div>
            <h4>${title}</h4>
            <p>${desc}</p>
        `;
        return div;
    }

    private static async handleAddItemSubmit() {
        if (this.getCurrentRole() !== 'ADMIN') {
            ToastManager.show('Admin Access Required', 'Only administrators can add new components to the vault.', 'warning');
            return;
        }

        const name = (document.getElementById('item-name') as HTMLInputElement).value.trim();
        const category = (document.getElementById('item-category') as HTMLSelectElement).value;
        const qty = parseInt((document.getElementById('item-qty') as HTMLInputElement).value);
        const location = (document.getElementById('item-location') as HTMLInputElement).value.trim();
        const specs = (document.getElementById('item-specs') as HTMLTextAreaElement).value.trim() || "No specifications provided.";
        const rawTags = (document.getElementById('item-tags') as HTMLInputElement)?.value || '';
        const tags = rawTags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

        if (!name || !category || isNaN(qty) || !location) {
            ToastManager.show('Missing Fields', 'Please complete all required fields.', 'warning');
            return;
        }

        if (qty <= 0) {
            ToastManager.show('Invalid Quantity', 'Total quantity must be at least 1.', 'warning');
            return;
        }

        const MAX_QUANTITY_LIMIT = 500;
        if (qty > MAX_QUANTITY_LIMIT) {
            ToastManager.show('Quantity Exceeds Limit', `Maximum quantity per component entry is capped at ${MAX_QUANTITY_LIMIT} units.`, 'warning');
            return;
        }

        const submitBtn = document.getElementById('btn-add-submit') as HTMLButtonElement;
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<span>Vaulting Component...</span>`;
        }

        const catMap: Record<string, string> = {
            microcontrollers: 'Controllers',
            sensors: 'Sensors',
            actuators: 'Actuators',
            power: 'Power',
            tools: 'Tools'
        };
        const backendCategory = catMap[category] || 'Controllers';

        const token = localStorage.getItem('cicr_token');
        try {
            const res = await fetch(`${API_BASE}/items`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    name,
                    category: backendCategory,
                    quantity: qty,
                    location,
                    description: specs,
                    tags
                })
            });

            if (res.ok) {
                (document.getElementById('add-item-form') as HTMLFormElement).reset();
                this.close('add-item-modal');
                ToastManager.show('Component Vaulted', `Added ${qty}x ${name} to ${location}. Telemetry alert sent to administrators.`, 'success');
                DatabaseManager.addLog('add', `Registered new component <span>${name}</span> (Qty: ${qty}) at <span>${location}</span>.`);
                await DatabaseManager.syncFromBackend();
                return;
            } else {
                const errJson = await res.json();
                ToastManager.show('Action Failed', errJson.message || 'Failed to add item to database.', 'error');
            }
        } catch (e) {
            console.error('Failed to create item in backend:', e);
            ToastManager.show('Connection Error', 'Failed to reach database backend.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
                lucide.createIcons();
            }
        }

        // Fallback local addition if offline
        const id = `${category.slice(0, 2)}-${Date.now().toString().slice(-4)}`;
        const newItem: InventoryItem = {
            id,
            name,
            category,
            quantity: qty,
            availableQuantity: qty,
            location,
            specs,
            tags,
            borrowedBy: []
        };
        inventory.unshift(newItem);
        DatabaseManager.addLog('add', `Registered new component <span>${name}</span> (Qty: ${qty}) at <span>${location}</span>.`);
        (document.getElementById('add-item-form') as HTMLFormElement).reset();
        this.close('add-item-modal');
        ToastManager.show('Component Saved', `Stored ${qty}x ${name} locally`, 'info');
        if (window.dashboard) {
            window.dashboard.init();
        }
    }

    private static isSubmittingBorrow = false;

    private static async handleBorrowSubmit() {
        if (!selectedItem || this.isSubmittingBorrow) return;

        const borrowerName = (document.getElementById('borrow-name') as HTMLInputElement).value.trim();
        const rollNum = (document.getElementById('borrow-roll') as HTMLInputElement).value.trim();
        const qty = parseInt((document.getElementById('borrow-qty') as HTMLInputElement).value);
        const purpose = (document.getElementById('borrow-purpose') as HTMLInputElement).value.trim();

        const borrowedSum = (selectedItem.borrowedBy || []).reduce((sum, rec) => sum + rec.qty, 0);
        const available = typeof selectedItem.availableQuantity === 'number'
            ? selectedItem.availableQuantity
            : Math.max(0, selectedItem.quantity - borrowedSum);

        if (qty > available || qty <= 0 || isNaN(qty) || !borrowerName || !rollNum || !purpose) {
            ToastManager.show('Invalid Input', 'Please enter a valid borrow quantity within available limits.', 'warning');
            return;
        }

        const dueDateInput = document.getElementById('borrow-due-date') as HTMLInputElement | null;
        const defaultDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const dueDate = (dueDateInput && dueDateInput.value) ? dueDateInput.value : defaultDue;

        const token = localStorage.getItem('cicr_token');
        if (!token) {
            ToastManager.show('Login Required', 'Please log in to submit a component issue request.', 'error');
            return;
        }

        const submitBtn = document.getElementById('borrow-form-submit') as HTMLButtonElement | null;
        this.isSubmittingBorrow = true;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerText = 'Submitting Request...';
        }

        const storedUser = JSON.parse(localStorage.getItem('cicr_user') || '{}');
        const userEmail = storedUser.email || (localStorage.getItem('cicr_auth')?.includes('@') ? localStorage.getItem('cicr_auth') : 'vardaansaxena096@gmail.com');

        // Route component checkout request to the Admin Portal Request Queue
        const date = new Date().toISOString().split('T')[0];
        const requestId = `req-${Date.now()}`;
        const newReq: RequestRecord = {
            id: requestId,
            itemId: selectedItem.id,
            itemName: selectedItem.name,
            name: borrowerName,
            roll: rollNum,
            qty: qty,
            purpose: purpose,
            status: 'PENDING',
            requestedAt: date,
            dueDate: dueDate
        };

        const requestPayload = {
            id: requestId,
            itemId: selectedItem.id,
            inventory_id: selectedItem.id,
            item_id: selectedItem.id,
            itemName: selectedItem.name,
            quantity: qty,
            purpose: purpose,
            duration_days: 7,
            dueDate: dueDate,
            borrowerName: borrowerName,
            borrower_name: borrowerName,
            borrowerEmail: userEmail,
            borrower_email: userEmail,
            rollNumber: rollNum,
            roll_number: rollNum,
            status: 'PENDING'
        };

        try {
            const res = await fetch(`${API_BASE}/borrow/request`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(requestPayload)
            });

            const resData = await res.json().catch(() => ({})) as any;
            if (resData?.data?.id) {
                newReq.id = resData.data.id;
            }

            // Always keep in local requests store so it is instantly reflected on this client, deduplicating against any existing match
            requests = requests.filter(r => r.id !== newReq.id && !(r.status === 'PENDING' && r.itemId === newReq.itemId && r.qty === newReq.qty && r.purpose === newReq.purpose));
            requests.unshift(newReq);
            DatabaseManager.save();

            (document.getElementById('borrow-form') as HTMLFormElement).reset();
            this.close('borrow-form-modal');

            ToastManager.show(
                'Request Transmitted',
                `Issue request for ${qty}x ${selectedItem.name} submitted for Admin authorization.`,
                'success'
            );
            DatabaseManager.addLog('borrow', `<span>${borrowerName}</span> requested ${qty}x <span>${selectedItem.name}</span> for '${purpose}'.`);
            AdminManager.loadHardwareRequests(true);
            DatabaseManager.updateNotificationBadges();
            await DatabaseManager.syncFromBackend();
        } catch (e: any) {
            console.error('Request API error:', e);
            // On offline/failover, save locally
            requests = requests.filter(r => r.id !== newReq.id && !(r.status === 'PENDING' && r.itemId === newReq.itemId && r.qty === newReq.qty && r.purpose === newReq.purpose));
            requests.unshift(newReq);
            DatabaseManager.save();
            (document.getElementById('borrow-form') as HTMLFormElement).reset();
            this.close('borrow-form-modal');
            ToastManager.show(
                'Request Transmitted',
                `Issue request for ${qty}x ${selectedItem.name} queued for Admin authorization.`,
                'success'
            );
            DatabaseManager.addLog('borrow', `<span>${borrowerName}</span> requested ${qty}x <span>${selectedItem.name}</span> for '${purpose}'.`);
            AdminManager.loadHardwareRequests(true);
        } finally {
            this.isSubmittingBorrow = false;
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerText = 'Submit Issue Request';
            }
        }
    }

    // Opens the return quantity selector. All users (both admins and members) choose
    // how many borrowed units to return; all requests are sent to the Admin Portal for approval.
    public static openReturnModal(rec: BorrowRecord, item: InventoryItem, origIdx: number) {
        if (!rec || !rec.id) {
            ToastManager.show('Return Unavailable', 'This loan is not linked to a server record yet.', 'warning');
            return;
        }

        // Strict ownership enforcement: only the person who issued the loan can return it
        if (!ModalManager.isUserLoanMatch(rec)) {
            ToastManager.show('Return Prohibited', 'You can only initiate returns for components you have personally borrowed.', 'warning');
            return;
        }

        const borrowedQty = Math.max(1, Number(rec.qty) || 1);

        const nameEl = document.getElementById('return-modal-item-name');
        if (nameEl) nameEl.innerText = item.name;

        const holderInfo = document.getElementById('return-modal-holder-info');
        if (holderInfo) {
            holderInfo.innerText = `Borrower: ${rec.name || 'Member'} (${rec.roll || 'Enrolled'}) · Issued: ${borrowedQty} unit(s) on ${rec.date || 'Active'}`;
        }

        (document.getElementById('return-borrow-id') as HTMLInputElement).value = rec.id;
        (document.getElementById('return-borrow-idx') as HTMLInputElement).value = String(origIdx);

        const qtyInput = document.getElementById('return-qty-input') as HTMLInputElement;
        qtyInput.min = '1';
        qtyInput.max = String(borrowedQty);
        qtyInput.value = String(borrowedQty);

        const maxLabel = document.getElementById('return-qty-max-label');
        if (maxLabel) maxLabel.innerText = `of ${borrowedQty} borrowed`;

        const subtitle = document.getElementById('return-modal-subtitle');
        if (subtitle) subtitle.innerText = 'Choose how many borrowed units you wish to return';

        const noteText = document.getElementById('return-modal-note-text');
        if (noteText) noteText.innerText = 'Return requests are sent to the Admin Portal for verification. Stock is checked back into inventory once approved by an administrator.';

        const submitBtn = document.getElementById('btn-confirm-return-submit') as HTMLButtonElement | null;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i data-lucide="corner-up-left"></i> Submit Return to Admin';
        }

        ModalManager.updateReturnQtyPreview();
        this.open('return-qty-modal');
        lucide.createIcons();
    }

    private static isSubmittingReturn = false;

    // Submits a full or partial return. Always hits /borrow/return-request so that
    // requests (from both admins and members) go to the Admin Portal for verification.
    public static async handleReturnSubmission(borrowId: string, qtyVal: number, _idx: number) {
        if (!borrowId || this.isSubmittingReturn) {
            if (!borrowId) ToastManager.show('Return Error', 'Borrow reference is missing.', 'error');
            return;
        }
        this.isSubmittingReturn = true;

        const isAdmin = this.getCurrentRole() === 'ADMIN';
        const token = localStorage.getItem('cicr_token');
        const submitBtn = document.getElementById('btn-confirm-return-submit') as HTMLButtonElement | null;
        const itemName = (document.getElementById('return-modal-item-name')?.innerText || 'Component').trim();
        const requestedQty = Math.max(1, Number(qtyVal) || 1);

        if (submitBtn) submitBtn.disabled = true;

        try {
            const endpoint = `${API_BASE}/borrow/return-request`;
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ borrowId, returnQuantity: requestedQty })
            });

            const payload = await res.json().catch(() => ({})) as any;
            const ok = res.ok || res.status === 202;

            if (!ok) {
                ToastManager.show('Return Error', payload.message || 'Failed to submit the return.', 'error');
                if (submitBtn) submitBtn.disabled = false;
                return;
            }

            this.close('return-qty-modal');

            ToastManager.show(
                'Return Request Submitted',
                `Return of ${requestedQty}x ${itemName} is awaiting Administrator approval in the Admin Portal.`,
                'success'
            );
            DatabaseManager.addLog('return', `<span>${itemName}</span> return request submitted for ${requestedQty} unit(s) — pending admin approval.`);

            // Reflect the pending return immediately in the local requests list.
            const localUser = (() => {
                try { return JSON.parse(localStorage.getItem('cicr_user') || '{}'); } catch { return {}; }
            })();
            const returnId = payload?.data?.id || `req-ret-local-${Date.now()}`;
            const localReq: RequestRecord = {
                id: returnId,
                type: 'RETURN',
                borrowId,
                returnQuantity: requestedQty,
                itemId: selectedItem?.id || '',
                itemName,
                name: localUser.name || localStorage.getItem('cicr_auth') || 'Member',
                roll: localUser.roll_number || localUser.roll || '',
                qty: requestedQty,
                purpose: `Return ${requestedQty} unit(s)`,
                status: 'PENDING',
                requestedAt: new Date().toISOString()
            };
            // Deduplicate: remove any existing pending return for this borrowId or id
            requests = requests.filter(r => !(r.id === returnId || (r.type === 'RETURN' && (r as any).borrowId === borrowId)));
            requests.unshift(localReq);
            DatabaseManager.save();

            await DatabaseManager.syncFromBackend();

            if (selectedItem) {
                const refreshed = inventory.find(i => i.id === selectedItem?.id);
                if (refreshed) this.openDetailModal(refreshed);
            }
            DatabaseManager.updateNotificationBadges();

            if (isAdmin) {
                AdminManager.loadHardwareRequests(true);
            }
        } catch (e) {
            console.error('Return API error:', e);
            ToastManager.show('Network Error', 'Failed to reach server.', 'error');
            if (submitBtn) submitBtn.disabled = false;
        } finally {
            this.isSubmittingReturn = false;
        }
    }

    // Opens the Consolidated Bulk Return Modal ("Return Everything in 1 Go")
    public static openBulkReturnModal() {
        const userLoansMap = new Map<string, { item: InventoryItem; records: BorrowRecord[]; totalQty: number }>();
        let totalIssuedUnits = 0;

        inventory.forEach(item => {
            (item.borrowedBy || []).forEach(rec => {
                if (!rec.returned && (rec as any).status !== 'RETURN_REQUESTED' && ModalManager.isUserLoanMatch(rec)) {
                    const existing = userLoansMap.get(item.id);
                    const qty = Math.max(1, Number(rec.qty) || 1);
                    totalIssuedUnits += qty;
                    if (existing) {
                        existing.records.push(rec);
                        existing.totalQty += qty;
                    } else {
                        userLoansMap.set(item.id, { item, records: [rec], totalQty: qty });
                    }
                }
            });
        });

        if (userLoansMap.size === 0) {
            ToastManager.show('No Active Loans', 'You do not have any active hardware loans available to return.', 'info');
            return;
        }

        const storedUser = (() => {
            try { return JSON.parse(localStorage.getItem('cicr_user') || '{}'); } catch { return {}; }
        })();
        const borrowerName = storedUser.name || localStorage.getItem('cicr_auth') || 'Member';
        const borrowerEmail = storedUser.email || (localStorage.getItem('cicr_auth')?.includes('@') ? localStorage.getItem('cicr_auth') : 'student@mail.jiit.ac.in');
        const rollNum = storedUser.roll_number || storedUser.roll || (borrowerEmail.includes('@') ? borrowerEmail.split('@')[0] : '');

        const nameEl = document.getElementById('bulk-return-borrower-name');
        if (nameEl) nameEl.innerText = borrowerName;

        const metaEl = document.getElementById('bulk-return-borrower-meta');
        if (metaEl) metaEl.innerText = `Roll: ${rollNum || 'Enrolled'} · ${borrowerEmail}`;

        const avatarEl = document.getElementById('bulk-return-avatar');
        if (avatarEl) avatarEl.innerText = borrowerName.charAt(0).toUpperCase();

        const totalIssuedEl = document.getElementById('bulk-total-issued-count');
        if (totalIssuedEl) totalIssuedEl.innerText = String(totalIssuedUnits);

        const listContainer = document.getElementById('bulk-return-items-list');
        if (!listContainer) return;
        listContainer.innerHTML = '';

        const updateSummary = () => {
            let totalSelectedUnits = 0;
            let totalSelectedItems = 0;
            const rows = listContainer.querySelectorAll<HTMLElement>('.bulk-return-item-card');
            rows.forEach(row => {
                const input = row.querySelector<HTMLInputElement>('.bulk-stepper-input');
                const max = Number(row.dataset.maxQty || 0);
                const val = Math.max(0, Math.min(max, Number(input?.value || 0)));
                if (val > 0) {
                    totalSelectedUnits += val;
                    totalSelectedItems++;
                }

                const badge = row.querySelector<HTMLElement>('.bulk-status-badge');
                if (badge) {
                    if (val === 0) {
                        badge.className = 'bulk-status-badge bulk-status-zero';
                        badge.innerText = `Keep Issued (0/${max})`;
                    } else if (val === max) {
                        badge.className = 'bulk-status-badge bulk-status-full';
                        badge.innerText = `Full Return (${val}/${max})`;
                    } else {
                        badge.className = 'bulk-status-badge bulk-status-partial';
                        badge.innerText = `Partial (${val}/${max})`;
                    }
                }
            });

            const summaryCount = document.getElementById('bulk-summary-count');
            if (summaryCount) {
                summaryCount.innerText = `${totalSelectedItems} item${totalSelectedItems === 1 ? '' : 's'} (${totalSelectedUnits} unit${totalSelectedUnits === 1 ? '' : 's'})`;
            }

            const submitBtn = document.getElementById('btn-submit-bulk-return') as HTMLButtonElement | null;
            if (submitBtn) {
                submitBtn.disabled = totalSelectedUnits === 0;
                submitBtn.innerHTML = `<i data-lucide="corner-up-left"></i> Submit Return (${totalSelectedUnits} Units)`;
                lucide.createIcons();
            }
        };

        userLoansMap.forEach(({ item, totalQty }) => {
            const card = document.createElement('div');
            card.className = 'bulk-return-item-card';
            card.dataset.itemId = item.id;
            card.dataset.maxQty = String(totalQty);

            card.innerHTML = `
                <div class="bulk-item-left">
                    <div class="bulk-item-icon">
                        <i data-lucide="cpu"></i>
                    </div>
                    <div class="bulk-item-info">
                        <div class="bulk-item-name" title="${AdminManager.escapeHtml(item.name)}">${AdminManager.escapeHtml(item.name)}</div>
                        <div class="bulk-item-meta">${totalQty} unit${totalQty === 1 ? '' : 's'} currently issued</div>
                    </div>
                </div>
                <div class="bulk-item-right">
                    <span class="bulk-status-badge bulk-status-full">Full Return (${totalQty}/${totalQty})</span>
                    <div class="bulk-stepper-wrap">
                        <button type="button" class="bulk-stepper-btn btn-minus">-</button>
                        <input type="number" class="bulk-stepper-input" min="0" max="${totalQty}" value="${totalQty}">
                        <button type="button" class="bulk-stepper-btn btn-plus">+</button>
                    </div>
                </div>
            `;

            const input = card.querySelector<HTMLInputElement>('.bulk-stepper-input')!;
            const btnMinus = card.querySelector<HTMLButtonElement>('.btn-minus')!;
            const btnPlus = card.querySelector<HTMLButtonElement>('.btn-plus')!;

            btnMinus.addEventListener('click', () => {
                const cur = Number(input.value) || 0;
                if (cur > 0) {
                    input.value = String(cur - 1);
                    updateSummary();
                }
            });

            btnPlus.addEventListener('click', () => {
                const cur = Number(input.value) || 0;
                if (cur < totalQty) {
                    input.value = String(cur + 1);
                    updateSummary();
                }
            });

            input.addEventListener('input', () => {
                let v = Number(input.value);
                if (isNaN(v) || v < 0) v = 0;
                if (v > totalQty) v = totalQty;
                input.value = String(v);
                updateSummary();
            });

            const statusBadge = card.querySelector<HTMLElement>('.bulk-status-badge');
            if (statusBadge) {
                statusBadge.setAttribute('title', 'Click to toggle return quantity');
                statusBadge.addEventListener('click', () => {
                    const cur = Number(input.value) || 0;
                    input.value = cur > 0 ? '0' : String(totalQty);
                    updateSummary();
                });
            }

            listContainer.appendChild(card);
        });

        // Wire shortcut buttons
        const btnAll100 = document.getElementById('btn-bulk-return-all-100');
        if (btnAll100) {
            btnAll100.onclick = () => {
                listContainer.querySelectorAll<HTMLElement>('.bulk-return-item-card').forEach(row => {
                    const input = row.querySelector<HTMLInputElement>('.bulk-stepper-input');
                    const max = row.dataset.maxQty || '0';
                    if (input) input.value = max;
                });
                updateSummary();
            };
        }

        const btnResetZero = document.getElementById('btn-bulk-reset-zero');
        if (btnResetZero) {
            btnResetZero.onclick = () => {
                listContainer.querySelectorAll<HTMLElement>('.bulk-return-item-card').forEach(row => {
                    const input = row.querySelector<HTMLInputElement>('.bulk-stepper-input');
                    if (input) input.value = '0';
                });
                updateSummary();
            };
        }

        const cancelBtn = document.getElementById('btn-cancel-bulk-return');
        if (cancelBtn) {
            cancelBtn.onclick = () => this.close('bulk-return-modal');
        }

        const closeBtn = document.getElementById('close-bulk-return-modal');
        if (closeBtn) {
            closeBtn.onclick = () => this.close('bulk-return-modal');
        }

        const submitBtn = document.getElementById('btn-submit-bulk-return') as HTMLButtonElement | null;
        if (submitBtn) {
            submitBtn.onclick = async () => {
                await this.submitBulkReturn(listContainer);
            };
        }

        updateSummary();
        this.open('bulk-return-modal');
        lucide.createIcons();
    }

    public static async submitBulkReturn(listContainer: HTMLElement) {
        const itemsToReturn: Array<{ itemId: string; quantity: number }> = [];
        const rows = listContainer.querySelectorAll<HTMLElement>('.bulk-return-item-card');
        rows.forEach(row => {
            const itemId = row.dataset.itemId;
            const input = row.querySelector<HTMLInputElement>('.bulk-stepper-input');
            const qty = Math.max(0, Number(input?.value || 0));
            if (itemId && qty > 0) {
                itemsToReturn.push({ itemId, quantity: qty });
            }
        });

        if (itemsToReturn.length === 0) {
            ToastManager.show('No Items Selected', 'Please select at least 1 unit to return.', 'warning');
            return;
        }

        const submitBtn = document.getElementById('btn-submit-bulk-return') as HTMLButtonElement | null;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i data-lucide="loader-2" class="animate-spin"></i> Submitting Dispatch...';
        }

        const token = localStorage.getItem('cicr_token');
        const isAdmin = this.getCurrentRole() === 'ADMIN';

        try {
            const res = await fetch(`${API_BASE}/borrow/bulk-return-request`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ items: itemsToReturn })
            });

            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                ToastManager.show('Return Error', json.message || 'Failed to submit consolidated return.', 'error');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i data-lucide="corner-up-left"></i> Submit Return to Admin';
                }
                return;
            }

            this.close('bulk-return-modal');

            const totalQty = itemsToReturn.reduce((sum, it) => sum + it.quantity, 0);
            ToastManager.show(
                'Consolidated Return Submitted',
                `Return requests for ${itemsToReturn.length} component(s) (${totalQty} units) dispatched to Admin Portal for verification.`,
                'success'
            );
            DatabaseManager.addLog('return', `Consolidated return request submitted for ${itemsToReturn.length} item(s) (${totalQty} units) — pending admin approval.`);

            // Add local request records so UI immediately reflects pending return status
            const storedUser = (() => {
                try { return JSON.parse(localStorage.getItem('cicr_user') || '{}'); } catch { return {}; }
            })();
            const borrowerName = storedUser.name || localStorage.getItem('cicr_auth') || 'Member';
            const rollNum = storedUser.roll_number || storedUser.roll || '';

            itemsToReturn.forEach(({ itemId, quantity }) => {
                const targetItem = inventory.find(it => it.id === itemId);
                const localReq: RequestRecord = {
                    id: `req-ret-bulk-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                    type: 'RETURN',
                    itemId,
                    itemName: targetItem?.name || 'Component',
                    name: borrowerName,
                    roll: rollNum,
                    qty: quantity,
                    purpose: `Return ${quantity} unit(s) (Consolidated)`,
                    status: 'PENDING',
                    requestedAt: new Date().toISOString()
                };
                requests.unshift(localReq);
            });
            DatabaseManager.save();

            await DatabaseManager.syncFromBackend();
            DatabaseManager.updateNotificationBadges();

            if (isAdmin) {
                AdminManager.loadHardwareRequests(true);
            }
        } catch (err: any) {
            console.error('Bulk return submission error:', err);
            ToastManager.show('Network Error', 'Failed to connect to backend server.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i data-lucide="corner-up-left"></i> Submit Return to Admin';
                lucide.createIcons();
            }
        }
    }
}

// ==========================================
// 6. User Authentication & Admin Approval Manager
// ==========================================
class AuthManager {
    private static loginForm: HTMLFormElement;
    private static signupForm: HTMLFormElement;
    private static authOverlay: HTMLElement;
    private static appContainer: HTMLElement;
    private static globalNavbar: HTMLElement;

    private static loginUserInp: HTMLInputElement;
    private static loginPassInp: HTMLInputElement;
    private static loginErr: HTMLElement;

    private static signupNameInp: HTMLInputElement;
    private static signupEmailInp: HTMLInputElement;
    private static signupUserInp: HTMLInputElement;
    private static signupEnrollmentInp: HTMLInputElement;
    private static signupBatchInp: HTMLInputElement;
    private static signupPassInp: HTMLInputElement;
    private static signupErr: HTMLElement;
    private static signupSuccess: HTMLElement;

    private static navUsername: HTMLElement;
    private static navLogoutBtn: HTMLElement;

    static init() {
        this.loginForm = document.getElementById('login-form') as HTMLFormElement;
        this.signupForm = document.getElementById('signup-form') as HTMLFormElement;
        this.authOverlay = document.getElementById('auth-overlay')!;
        this.appContainer = document.getElementById('app-container')!;
        this.globalNavbar = document.getElementById('global-navbar')!;

        this.loginUserInp = document.getElementById('login-username') as HTMLInputElement;
        this.loginPassInp = document.getElementById('login-password') as HTMLInputElement;
        this.loginErr = document.getElementById('login-error')!;

        this.signupNameInp = document.getElementById('signup-name') as HTMLInputElement;
        this.signupEmailInp = document.getElementById('signup-email') as HTMLInputElement;
        this.signupUserInp = document.getElementById('signup-username') as HTMLInputElement;
        this.signupEnrollmentInp = document.getElementById('signup-enrollment') as HTMLInputElement;
        this.signupBatchInp = document.getElementById('signup-batch') as HTMLInputElement;
        this.signupPassInp = document.getElementById('signup-password') as HTMLInputElement;
        this.signupErr = document.getElementById('signup-error')!;
        this.signupSuccess = document.getElementById('signup-success')!;

        this.navUsername = document.getElementById('nav-username')!;
        this.navLogoutBtn = document.getElementById('nav-logout')!;

        const sideLogoutBtn = document.getElementById('sidebar-logout-btn');
        if (sideLogoutBtn) {
            sideLogoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleLogout();
            });
        }

        this.updateAdminVisibility(ModalManager.getCurrentRole());
        PasswordResetManager.init();
        this.setupEventListeners();
        this.checkAuth();
    }

    private static setupEventListeners() {
        const authCard = document.querySelector('.auth-card') as HTMLElement | null;
        const tabLoginBtn = document.getElementById('tab-login-btn');
        const tabSignupBtn = document.getElementById('tab-signup-btn');

        const switchToLogin = () => {
            this.signupForm.style.display = 'none';
            this.loginForm.style.display = 'block';
            this.signupErr.style.display = 'none';
            this.signupSuccess.style.display = 'none';
            this.loginForm.reset();
            authCard?.classList.remove('auth-card-wide');
            tabLoginBtn?.classList.add('active');
            tabSignupBtn?.classList.remove('active');
        };

        const switchToSignup = () => {
            this.loginForm.style.display = 'none';
            this.signupForm.style.display = 'block';
            this.loginErr.style.display = 'none';
            this.signupForm.reset();
            authCard?.classList.add('auth-card-wide');
            tabSignupBtn?.classList.add('active');
            tabLoginBtn?.classList.remove('active');
        };

        document.getElementById('go-to-signup')?.addEventListener('click', (e) => {
            e.preventDefault();
            switchToSignup();
        });

        document.getElementById('go-to-login')?.addEventListener('click', (e) => {
            e.preventDefault();
            switchToLogin();
        });

        document.getElementById('btn-open-forgot-password')?.addEventListener('click', (e) => {
            e.preventDefault();
            PasswordResetManager.open();
        });

        document.getElementById('sidebar-reset-pass-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            PasswordResetManager.open();
        });

        tabLoginBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            switchToLogin();
        });

        tabSignupBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            switchToSignup();
        });

        this.loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });

        this.signupForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleSignup();
        });

        this.navLogoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.handleLogout();
        });

        // Password visibility toggles
        const loginToggle = document.getElementById('login-password-toggle')!;
        const loginPass = document.getElementById('login-password') as HTMLInputElement;
        if (loginToggle && loginPass) {
            loginToggle.addEventListener('click', () => {
                const currentType = loginPass.getAttribute('type');
                const newType = currentType === 'password' ? 'text' : 'password';
                loginPass.setAttribute('type', newType);

                const icon = loginToggle.querySelector('i')!;
                if (icon) {
                    icon.setAttribute('data-lucide', newType === 'password' ? 'eye' : 'eye-off');
                    lucide.createIcons();
                }
            });
        }

        const signupToggle = document.getElementById('signup-password-toggle')!;
        const signupPass = document.getElementById('signup-password') as HTMLInputElement;
        if (signupToggle && signupPass) {
            signupToggle.addEventListener('click', () => {
                const currentType = signupPass.getAttribute('type');
                const newType = currentType === 'password' ? 'text' : 'password';
                signupPass.setAttribute('type', newType);

                const icon = signupToggle.querySelector('i')!;
                if (icon) {
                    icon.setAttribute('data-lucide', newType === 'password' ? 'eye' : 'eye-off');
                    lucide.createIcons();
                }
            });
        }
    }

    private static async checkAuth() {
        const welcomeScreen = document.getElementById('welcome-screen');
        if (welcomeScreen) welcomeScreen.style.display = 'none';

        const token = localStorage.getItem('cicr_token');
        if (!token) {
            this.showLoginOverlay();
            return;
        }

        // Optimistic instant session activation: eliminates auth modal flash on page reload
        const cachedUserStr = localStorage.getItem('cicr_user');
        const cachedAuth = localStorage.getItem('cicr_auth');
        const cachedRole = (localStorage.getItem('cicr_role') as UserRole) || 'MEMBER';
        if (cachedUserStr || cachedAuth) {
            let userObj = null;
            try { if (cachedUserStr) userObj = JSON.parse(cachedUserStr); } catch { }
            const fallbackName = userObj?.name || cachedAuth || 'Operator';
            this.loginSuccess(fallbackName, cachedRole, userObj);
        }

        try {
            const res = await fetch(`${API_BASE}/auth/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                const result = await res.json();
                const user = result.data;
                if (user && user.status === 'APPROVED') {
                    this.loginSuccess(user.name, user.role, user);
                    const welcomedKey = 'cicr_welcomed_' + (user.name || 'user');
                    if (!sessionStorage.getItem(welcomedKey)) {
                        sessionStorage.setItem(welcomedKey, 'true');
                        ToastManager.showWelcome(user.name, user.role);
                    }
                    return;
                }
            } else if (res.status === 401 || res.status === 403) {
                this.handleLogout();
                return;
            }
        } catch (err) {
            console.warn('Profile validation check failed (server may be waking up):', err);
        }

        if (!cachedUserStr && !cachedAuth) {
            this.handleLogout();
        }
    }

    private static showLoginOverlay() {
        this.globalNavbar.style.display = 'none';
        this.authOverlay.classList.remove('hidden');
        this.authOverlay.style.display = 'flex';
        this.appContainer.style.display = 'none';
        this.updateAdminVisibility('MEMBER');

        // Reset to default sign-in state
        this.signupForm.style.display = 'none';
        this.loginForm.style.display = 'block';
        document.querySelector('.auth-card')?.classList.remove('auth-card-wide');
        document.getElementById('tab-login-btn')?.classList.add('active');
        document.getElementById('tab-signup-btn')?.classList.remove('active');
    }

    private static isAllowedEmail(email: string): boolean {
        const norm = email.trim().toLowerCase();
        const currentAdmins = [
            'vardaansaxena096@gmail.com',
            'cicrinventory@gmail.com'
        ];
        if (currentAdmins.includes(norm)) return true;
        // JIIT student email with enrollment number or institutional domain
        return /^\d+@mail\.jiit\.ac\.in$/i.test(norm) ||
            /^[a-zA-Z0-9._%+-]+@mail\.jiit\.ac\.in$/i.test(norm) ||
            /^[a-zA-Z0-9._%+-]+@jiit\.ac\.in$/i.test(norm);
    }

    private static async handleLogin() {
        const identifier = this.loginUserInp.value.trim();
        const password = this.loginPassInp.value;

        this.loginErr.style.display = 'none';

        if (!identifier || !password) {
            this.showLoginError("Please enter your Email, Username, or Name, and Password.");
            return;
        }

        if (identifier.includes('@') && !this.isAllowedEmail(identifier)) {
            this.showLoginError("Access Restricted: Only JIIT accounts (enrollmentnumber@mail.jiit.ac.in) and authorized administrators can log in.");
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identifier, email: identifier, username: identifier, name: identifier, password }),
            });

            const data = await res.json();

            if (res.ok && data.token) {
                localStorage.setItem('cicr_token', data.token);
                if (data.user) {
                    localStorage.setItem('cicr_user', JSON.stringify(data.user));
                }
                const resolvedName = data.user?.name || identifier;
                const role = data.user?.role || 'MEMBER';
                this.loginSuccess(resolvedName, role, data.user);
                sessionStorage.setItem('cicr_welcomed_' + resolvedName, 'true');
                ToastManager.showWelcome(resolvedName, role);
                return;
            }

            if (data.status === 'pending_approval') {
                this.showLoginError(data.message || "Access Pending: Your account has been registered and is awaiting approval by the CICR Admin.");
                return;
            }

            if (data.status === 'rejected') {
                this.showLoginError(data.message || "Access Denied: Your account registration was rejected by the CICR Admin.");
                return;
            }

            this.showLoginError(data.message || "Invalid credentials. Please check your email, username, or name and password.");
        } catch (err) {
            this.showLoginError("Unable to reach backend server. Please verify your connection.");
        }
    }

    private static showLoginError(msg: string) {
        this.loginErr.innerText = msg;
        this.loginErr.style.display = 'block';
        this.loginErr.style.animation = 'none';
        this.loginErr.offsetHeight;
        this.loginErr.style.animation = 'shake-error 0.4s ease';
    }

    private static loginSuccess(username: string, role: string = 'MEMBER', _userObj?: any) {
        let effectiveRole: 'ADMIN' | 'MEMBER' = 'MEMBER';
        const normEmail = (_userObj?.email || '').toLowerCase().trim();

        if (ModalManager.isDesignatedAdminUser(normEmail, _userObj?.name, username) || role === 'ADMIN') {
            effectiveRole = 'ADMIN';
        } else {
            effectiveRole = 'MEMBER';
        }

        localStorage.setItem('cicr_auth', username);
        localStorage.setItem('cicr_role', effectiveRole);
        if (_userObj) {
            localStorage.setItem('cicr_user', JSON.stringify({ ..._userObj, role: effectiveRole }));
        }

        if (this.navUsername) {
            this.navUsername.innerText = username;
        }

        // Set username, role, and initial in the left sidebar profile card
        const profileUserDisplay = document.getElementById('profile-username-display');
        const profileAvatarInitial = document.getElementById('profile-avatar-initial');
        const profileRoleDisplay = document.querySelector('.sidebar-profile-box .profile-role') as HTMLElement;

        if (profileUserDisplay) profileUserDisplay.innerText = username;
        if (profileAvatarInitial) profileAvatarInitial.innerText = username.charAt(0).toUpperCase();
        if (profileRoleDisplay) {
            profileRoleDisplay.innerText = effectiveRole;
            if (effectiveRole === 'ADMIN') {
                profileRoleDisplay.style.color = '#ff007a';
            } else {
                profileRoleDisplay.style.color = 'var(--neon-cyan)';
            }
        }

        const welcomeScreen = document.getElementById('welcome-screen');
        if (welcomeScreen) welcomeScreen.style.display = 'none';

        // Directly transition: hide auth form, show app container
        this.authOverlay.style.display = 'none';
        this.appContainer.style.display = 'grid';

        // Show/Hide Admin Portal navigation & cards based strictly on role
        this.updateAdminVisibility(effectiveRole);

        // Select Dashboard link in the left sidebar by default
        const activeNavClass = () => {
            const sidebarLinks = document.querySelectorAll('.sidebar-nav-link');
            sidebarLinks.forEach(link => {
                const target = (link as HTMLElement).dataset.target;
                if (target === 'dashboard-view') {
                    link.classList.add('active');
                } else {
                    link.classList.remove('active');
                }
            });
            const sections = document.querySelectorAll('#app-main-content > section');
            sections.forEach(node => {
                const sec = node as HTMLElement;
                if (sec.id === 'dashboard-view') {
                    sec.classList.add('active');
                    sec.style.display = 'flex';
                } else {
                    sec.classList.remove('active');
                    sec.style.display = 'none';
                }
            });



            const breadcrumbActive = document.getElementById('breadcrumb-current');
            if (breadcrumbActive) breadcrumbActive.innerText = 'DASHBOARD';
        };
        activeNavClass();

        if (!window.dashboard) {
            window.dashboard = new DashboardManager();
        } else {
            window.dashboard.init();
        }
        renderLucideIcons();
        TerminalSimulator.start();

        if (effectiveRole === 'ADMIN') {
            AdminManager.init();
            AdminManager.loadUsers();
        }
    }

    public static updateAdminVisibility(role?: string) {
        const sideAdminLink = document.getElementById('side-nav-admin');
        const dashAdminCard = document.getElementById('dash-card-admin');
        const adminViewSection = document.getElementById('admin-view');
        const btnInventoryAdd = document.getElementById('btn-inventory-add-item');

        const activeRole = role !== undefined ? role : ModalManager.getCurrentRole();
        const isAdmin = activeRole === 'ADMIN';

        const roleSubtitleEl = document.getElementById('dashboard-subtitle-role');
        if (roleSubtitleEl) {
            roleSubtitleEl.innerText = isAdmin ? 'ADMIN DASHBOARD' : 'MEMBER DASHBOARD';
        }

        if (isAdmin) {
            document.body.classList.add('user-is-admin');
            if (sideAdminLink) {
                sideAdminLink.style.removeProperty('display');
                sideAdminLink.style.setProperty('display', 'flex', 'important');
            }
            if (dashAdminCard) {
                dashAdminCard.style.removeProperty('display');
                dashAdminCard.style.setProperty('display', 'flex', 'important');
            }
            if (btnInventoryAdd) {
                btnInventoryAdd.style.removeProperty('display');
                btnInventoryAdd.style.setProperty('display', 'inline-flex', 'important');
            }
            AdminManager.init();
        } else {
            document.body.classList.remove('user-is-admin');
            if (sideAdminLink) {
                sideAdminLink.style.setProperty('display', 'none', 'important');
            }
            if (dashAdminCard) {
                dashAdminCard.style.setProperty('display', 'none', 'important');
            }
            if (btnInventoryAdd) {
                btnInventoryAdd.style.setProperty('display', 'none', 'important');
            }
            if (adminViewSection) {
                adminViewSection.style.setProperty('display', 'none', 'important');
                adminViewSection.classList.remove('active');
            }
        }

        if (window.dashboard) {
            window.dashboard.renderInventory(true);
        }
    }

    private static async handleSignup() {
        const name = (this.signupNameInp ? this.signupNameInp.value : '').trim();
        const email = (this.signupEmailInp ? this.signupEmailInp.value : '').trim();
        const username = (this.signupUserInp ? this.signupUserInp.value : '').trim();
        const enrollment = (this.signupEnrollmentInp ? this.signupEnrollmentInp.value : '').trim();
        const batch = (this.signupBatchInp ? this.signupBatchInp.value : '').trim();
        const password = this.signupPassInp ? this.signupPassInp.value : '';

        this.signupErr.style.display = 'none';
        this.signupSuccess.style.display = 'none';

        if (name.length < 2) {
            this.showSignupError("Please enter your full name.");
            return;
        }

        if (!email || !email.includes('@')) {
            this.showSignupError("Please provide a valid email address.");
            return;
        }

        if (!this.isAllowedEmail(email)) {
            this.showSignupError("Registration Restricted: Only official JIIT student accounts (enrollmentnumber@mail.jiit.ac.in) can create an account.");
            return;
        }

        if (username.length < 3) {
            this.showSignupError("Username must be at least 3 characters.");
            return;
        }

        if (enrollment.length < 4) {
            this.showSignupError("Please enter a valid enrollment number.");
            return;
        }

        if (!batch) {
            this.showSignupError("Please enter your lab section batch (e.g. F1, F2, B3).");
            return;
        }

        if (password.length < 6) {
            this.showSignupError("Password must be at least 6 characters.");
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    email,
                    username,
                    roll_number: enrollment,
                    batch,
                    password
                }),
            });

            const data = await res.json();

            if (res.ok || data.status === 'success') {
                this.signupSuccess.innerText = data.message || "Registration request submitted! Your account is pending CICR Admin approval.";
                this.signupSuccess.style.display = 'block';

                DatabaseManager.addLog('system', `Registration requested: <span>${name}</span> (@${username}, ${email}, Batch: ${batch}).`);

                setTimeout(() => {
                    document.getElementById('go-to-login')!.click();
                }, 2200);
                return;
            }

            this.showSignupError(data.message || "Registration failed. Please check your information.");
        } catch (err) {
            this.showSignupError("Unable to reach backend server. Please verify your connection.");
        }
    }

    private static showSignupError(msg: string) {
        this.signupErr.innerText = msg;
        this.signupErr.style.display = 'block';
        this.signupErr.style.animation = 'none';
        this.signupErr.offsetHeight;
        this.signupErr.style.animation = 'shake-error 0.4s ease';
    }

    private static handleLogout() {
        localStorage.removeItem('cicr_auth');
        localStorage.removeItem('cicr_role');
        localStorage.removeItem('cicr_token');
        localStorage.removeItem('cicr_user');
        sessionStorage.clear();

        this.updateAdminVisibility('MEMBER');

        this.appContainer.style.display = 'none';
        this.globalNavbar.style.display = 'none';

        const welcomeScreen = document.getElementById('welcome-screen');
        if (welcomeScreen) {
            welcomeScreen.style.display = 'none';
            welcomeScreen.style.transform = 'translateY(0)';
        }

        this.authOverlay.style.display = 'flex';
        setTimeout(() => {
            this.authOverlay.classList.remove('hidden');
        }, 50);

        this.loginForm.reset();
        this.loginErr.style.display = 'none';
    }
}

// ==========================================
// 6.5 Password Reset & Credential Sync Manager (No OTP)
// ==========================================
class PasswordResetManager {
    private static resetModal: HTMLElement | null = null;
    private static directForm: HTMLFormElement | null = null;
    private static identifierInput: HTMLInputElement | null = null;
    private static currentPassInput: HTMLInputElement | null = null;
    private static newPassInput: HTMLInputElement | null = null;
    private static confirmPassInput: HTMLInputElement | null = null;
    private static errorEl: HTMLElement | null = null;

    static init() {
        this.resetModal = document.getElementById('reset-password-modal');
        this.directForm = document.getElementById('reset-direct-form') as HTMLFormElement | null;
        this.identifierInput = document.getElementById('reset-identifier') as HTMLInputElement | null;
        this.currentPassInput = document.getElementById('reset-current-password') as HTMLInputElement | null;
        this.newPassInput = document.getElementById('reset-new-password') as HTMLInputElement | null;
        this.confirmPassInput = document.getElementById('reset-confirm-password') as HTMLInputElement | null;
        this.errorEl = document.getElementById('reset-error');

        // Password visibility toggles
        const currentPassToggle = document.getElementById('reset-current-pass-toggle');
        if (currentPassToggle && this.currentPassInput && !currentPassToggle.dataset.bound) {
            currentPassToggle.dataset.bound = 'true';
            currentPassToggle.addEventListener('click', (e) => {
                e.preventDefault();
                if (!this.currentPassInput) return;
                const isPass = this.currentPassInput.type === 'password';
                this.currentPassInput.type = isPass ? 'text' : 'password';
                const icon = currentPassToggle.querySelector('i, svg');
                if (icon) {
                    icon.setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
                    lucide.createIcons();
                }
            });
        }

        const newPassToggle = document.getElementById('reset-new-pass-toggle');
        if (newPassToggle && this.newPassInput && !newPassToggle.dataset.bound) {
            newPassToggle.dataset.bound = 'true';
            newPassToggle.addEventListener('click', (e) => {
                e.preventDefault();
                if (!this.newPassInput) return;
                const isPass = this.newPassInput.type === 'password';
                this.newPassInput.type = isPass ? 'text' : 'password';
                const icon = newPassToggle.querySelector('i, svg');
                if (icon) {
                    icon.setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
                    lucide.createIcons();
                }
            });
        }

        const confirmPassToggle = document.getElementById('reset-confirm-pass-toggle');
        if (confirmPassToggle && this.confirmPassInput && !confirmPassToggle.dataset.bound) {
            confirmPassToggle.dataset.bound = 'true';
            confirmPassToggle.addEventListener('click', (e) => {
                e.preventDefault();
                if (!this.confirmPassInput) return;
                const isPass = this.confirmPassInput.type === 'password';
                this.confirmPassInput.type = isPass ? 'text' : 'password';
                const icon = confirmPassToggle.querySelector('i, svg');
                if (icon) {
                    icon.setAttribute('data-lucide', isPass ? 'eye-off' : 'eye');
                    lucide.createIcons();
                }
            });
        }

        if (this.directForm && !this.directForm.dataset.bound) {
            this.directForm.dataset.bound = 'true';
            this.directForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleDirectReset();
            });
        }

        const submitResetBtn = document.getElementById('btn-submit-reset-direct');
        if (submitResetBtn && !submitResetBtn.dataset.bound) {
            submitResetBtn.dataset.bound = 'true';
            submitResetBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.handleDirectReset();
            });
        }

        (window as any).openPasswordResetModal = () => this.open();
        (window as any).closePasswordResetModal = () => this.close();
    }

    static open() {
        this.init();
        if (!this.resetModal) {
            this.resetModal = document.getElementById('reset-password-modal');
        }
        if (!this.resetModal) return;

        if (this.directForm) this.directForm.reset();
        if (this.errorEl) this.errorEl.style.display = 'none';

        // Pre-fill with current user's email, roll number, or identifier
        let defaultId = '';
        try {
            const storedUser = JSON.parse(localStorage.getItem('cicr_user') || '{}');
            defaultId = storedUser.email || storedUser.roll_number || storedUser.username || '';
        } catch { }

        if (!defaultId) {
            defaultId = localStorage.getItem('cicr_auth') || '';
        }
        if (!defaultId) {
            const currentLoginVal = (document.getElementById('login-username') as HTMLInputElement)?.value.trim();
            defaultId = currentLoginVal || '';
        }

        if (defaultId && this.identifierInput) {
            this.identifierInput.value = defaultId;
        }

        this.resetModal.style.display = 'flex';
        void this.resetModal.offsetWidth;
        this.resetModal.classList.add('active');
        lucide.createIcons();

        if (defaultId && this.currentPassInput) {
            setTimeout(() => this.currentPassInput?.focus(), 150);
        } else if (this.identifierInput) {
            setTimeout(() => this.identifierInput?.focus(), 150);
        }
    }

    static close() {
        if (!this.resetModal) {
            this.resetModal = document.getElementById('reset-password-modal');
        }
        if (this.resetModal) {
            this.resetModal.classList.remove('active');
            setTimeout(() => {
                if (this.resetModal && !this.resetModal.classList.contains('active')) {
                    this.resetModal.style.display = 'none';
                }
            }, 260);
        }
    }

    private static async handleDirectReset() {
        if (!this.identifierInput || !this.currentPassInput || !this.newPassInput || !this.confirmPassInput) return;
        const identifier = this.identifierInput.value.trim();
        const currentPassword = this.currentPassInput.value;
        const newPassword = this.newPassInput.value;
        const confirmPassword = this.confirmPassInput.value;
        if (this.errorEl) this.errorEl.style.display = 'none';

        if (!identifier) {
            this.showError('Please enter your college email or enrollment number.');
            return;
        }

        if (!currentPassword) {
            this.showError('Please enter your current password to verify your identity.');
            return;
        }

        if (newPassword.length < 6) {
            this.showError('New password must be at least 6 characters.');
            return;
        }

        if (newPassword !== confirmPassword) {
            this.showError('New passwords do not match. Please verify and re-type.');
            return;
        }

        if (newPassword === currentPassword) {
            this.showError('New password cannot be the same as your current password.');
            return;
        }

        const submitBtn = document.getElementById('btn-submit-reset-direct') as HTMLButtonElement | null;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Verifying Credentials...`;
            lucide.createIcons();
        }

        try {
            const res = await fetch(`${API_BASE}/auth/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    identifier,
                    current_password: currentPassword,
                    new_password: newPassword
                })
            });

            const data = await res.json();

            if (!res.ok) {
                this.showError(data.message || 'Password update failed. Please check your credentials.');
                return;
            }

            // Successfully updated password in database!
            ToastManager.show(
                'Password Updated & Synced',
                'Your account credentials have been securely verified and updated in the database.',
                'success'
            );

            this.close();

            const isCurrentlyLoggedIn = Boolean(localStorage.getItem('cicr_token') || localStorage.getItem('cicr_auth'));
            if (!isCurrentlyLoggedIn) {
                // Pre-populate login form with email and switch to login view
                const loginUser = document.getElementById('login-username') as HTMLInputElement | null;
                if (loginUser) loginUser.value = identifier;
                const loginPass = document.getElementById('login-password') as HTMLInputElement | null;
                if (loginPass) {
                    loginPass.value = newPassword;
                    loginPass.focus();
                }

                document.getElementById('go-to-login')?.click();
            }
            DatabaseManager.addLog('system', `Password successfully updated in vault database for ${identifier}.`);
        } catch (err) {
            this.showError('Network error. Unable to contact authentication server.');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i data-lucide="shield-check"></i> Authenticate & Update Password`;
                lucide.createIcons();
            }
        }
    }

    private static showError(msg: string) {
        if (!this.errorEl) {
            this.errorEl = document.getElementById('reset-error');
        }
        if (this.errorEl) {
            this.errorEl.innerText = msg;
            this.errorEl.style.display = 'block';
            this.errorEl.style.animation = 'none';
            this.errorEl.offsetHeight;
            this.errorEl.style.animation = 'shake-error 0.4s ease';
        }
    }
}

// ==========================================
// Admin Member Management & Approval System
// ==========================================
interface AdminUserRecord {
    id: string;
    name: string;
    email: string;
    username?: string | null;
    batch?: string | null;
    roll_number: string | null;
    role: 'ADMIN' | 'MEMBER';
    status: 'APPROVED' | 'PENDING' | 'REJECTED';
    isMasterAdmin?: boolean;
    created_at: string;
}

interface AdminHardwareRequest {
    id: string;
    type?: 'ISSUE' | 'RETURN';
    borrowId?: string;
    returnQuantity?: number;
    itemId: string;
    itemName: string;
    category?: string;
    borrowerName: string;
    borrowerEmail: string;
    rollNumber?: string | null;
    quantity: number;
    purpose: string;
    durationDays: number;
    dueDate: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    requestedAt: string;
    reviewedAt?: string;
    reviewedBy?: string;
    reviewNote?: string;
}

class AdminManager {
    public static users: AdminUserRecord[] = [];
    public static hardwareRequests: AdminHardwareRequest[] = [];
    public static auditLogs: any[] = [];
    private static activeAuditCategory = 'all';
    private static auditSearchTerm = '';
    private static activeUserRoleFilter = 'all';
    private static isInitialized = false;
    private static lastHardwareQueueFingerprint = '';
    private static lastPendingQueueFingerprint = '';
    private static lastUsersTableFingerprint = '';

    static init() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const refreshBtn = document.getElementById('admin-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                const icon = refreshBtn.querySelector('i');
                if (icon) icon.classList.add('animate-spin');
                refreshBtn.setAttribute('disabled', 'true');
                try {
                    await this.loadUsers(true);
                    ToastManager.show('Directory Refreshed', 'User accounts and roles updated.', 'info');
                } finally {
                    if (icon) icon.classList.remove('animate-spin');
                    refreshBtn.removeAttribute('disabled');
                }
            });
        }

        const hwRefreshBtn = document.getElementById('admin-hw-refresh-btn');
        if (hwRefreshBtn) {
            hwRefreshBtn.addEventListener('click', async () => {
                const icon = hwRefreshBtn.querySelector('i');
                if (icon) icon.classList.add('animate-spin');
                hwRefreshBtn.setAttribute('disabled', 'true');
                try {
                    await this.loadHardwareRequests(true);
                    ToastManager.show('Queue Refreshed', 'Hardware issue requests updated.', 'info');
                } finally {
                    if (icon) icon.classList.remove('animate-spin');
                    hwRefreshBtn.removeAttribute('disabled');
                }
            });
        }

        const rolePills = document.getElementById('admin-users-role-pills');
        if (rolePills) {
            rolePills.querySelectorAll<HTMLButtonElement>('.audit-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    const filter = pill.getAttribute('data-user-filter') || 'all';
                    this.activeUserRoleFilter = filter;
                    rolePills.querySelectorAll('.audit-pill').forEach(p => p.classList.toggle('active', p === pill));
                    const searchInput = document.getElementById('admin-users-search') as HTMLInputElement;
                    this.renderUsersTable(this.filterUsers(searchInput ? searchInput.value : ''));
                });
            });
        }

        const searchInput = document.getElementById('admin-users-search') as HTMLInputElement;
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this.renderUsersTable(this.filterUsers(searchInput.value));
            });
        }

        const auditRefreshBtn = document.getElementById('admin-audit-refresh-btn');
        if (auditRefreshBtn) {
            auditRefreshBtn.addEventListener('click', async () => {
                const icon = auditRefreshBtn.querySelector('i');
                if (icon) icon.classList.add('animate-spin');
                auditRefreshBtn.setAttribute('disabled', 'true');
                try {
                    await this.loadAuditLogs();
                    ToastManager.show('Audit Refreshed', '7-Day system audit logs updated.', 'info');
                } finally {
                    if (icon) icon.classList.remove('animate-spin');
                    auditRefreshBtn.removeAttribute('disabled');
                }
            });
        }

        const show7DaysBtn = document.getElementById('admin-audit-show-7days-btn');
        if (show7DaysBtn) {
            show7DaysBtn.addEventListener('click', async () => {
                const icon = show7DaysBtn.querySelector('i');
                if (icon) icon.classList.add('animate-spin');
                show7DaysBtn.setAttribute('disabled', 'true');
                try {
                    await this.loadAuditLogs(true);
                    ToastManager.show('7-Day History Loaded', `Displaying complete 7-day activity ledger (${this.auditLogs.length} events).`, 'success');
                } finally {
                    if (icon) icon.classList.remove('animate-spin');
                    show7DaysBtn.removeAttribute('disabled');
                }
            });
        }

        const footerAllBtn = document.getElementById('admin-audit-footer-all-btn');
        if (footerAllBtn) {
            footerAllBtn.addEventListener('click', async () => {
                await this.loadAuditLogs(true);
                ToastManager.show('7-Day History Loaded', `Displaying all ${this.auditLogs.length} records across 7 days.`, 'success');
            });
        }

        const rangePills = document.querySelectorAll('#admin-audit-range-pills .audit-range-pill');
        rangePills.forEach(pill => {
            pill.addEventListener('click', async () => {
                rangePills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.activeAuditDaysRange = Number(pill.getAttribute('data-range-days') || '7');
                this.activeAuditDay = 'all';
                // Immediate client-side re-render for instantaneous tactile responsiveness
                this.renderAuditLogs();
                await this.loadAuditLogs();
            });
        });

        const auditExportBtn = document.getElementById('admin-audit-export-btn');
        if (auditExportBtn) {
            auditExportBtn.addEventListener('click', () => {
                this.exportAuditLogsCSV();
            });
        }

        const auditCleanupBtn = document.getElementById('admin-audit-cleanup-btn');
        if (auditCleanupBtn) {
            auditCleanupBtn.addEventListener('click', async () => {
                await this.triggerAuditRetentionCleanup();
            });
        }

        const auditSearch = document.getElementById('admin-audit-search') as HTMLInputElement;
        const auditSearchClear = document.getElementById('admin-audit-search-clear');
        if (auditSearch) {
            auditSearch.addEventListener('input', () => {
                this.auditSearchTerm = auditSearch.value.trim().toLowerCase();
                if (auditSearchClear) {
                    auditSearchClear.style.display = this.auditSearchTerm ? 'inline-flex' : 'none';
                }
                this.renderAuditLogs();
            });
        }
        if (auditSearchClear && auditSearch) {
            auditSearchClear.addEventListener('click', () => {
                auditSearch.value = '';
                this.auditSearchTerm = '';
                auditSearchClear.style.display = 'none';
                this.renderAuditLogs();
            });
        }

        const auditPills = document.querySelectorAll('#admin-audit-pills .audit-pill');
        auditPills.forEach(pill => {
            pill.addEventListener('click', () => {
                auditPills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.activeAuditCategory = (pill as HTMLElement).dataset.auditCat || 'all';
                this.loadAuditLogs();
            });
        });

        // Wire Audit Detail modal close & copy JSON
        const closeAuditModal = document.getElementById('close-audit-detail');
        const auditModal = document.getElementById('audit-detail-modal');
        if (closeAuditModal && auditModal) {
            closeAuditModal.addEventListener('click', () => {
                auditModal.classList.remove('active');
            });
            auditModal.addEventListener('click', (e) => {
                if (e.target === auditModal) auditModal.classList.remove('active');
            });
        }
        const copyJsonBtn = document.getElementById('audit-copy-json-btn');
        if (copyJsonBtn) {
            copyJsonBtn.addEventListener('click', () => {
                const pre = document.getElementById('audit-modal-json');
                if (pre && pre.innerText) {
                    navigator.clipboard.writeText(pre.innerText).then(() => {
                        ToastManager.show('Copied', 'Raw telemetry event JSON copied to clipboard.', 'success');
                    }).catch(() => {});
                }
            });
        }

        // Attach window methods for onclick handlers
        window.openAuditDetail = (id: string) => this.openAuditDetail(id);
        window.openBulkReturnModal = () => ModalManager.openBulkReturnModal();
        window.adminApprove = (id: string) => this.approveUser(id);
        window.adminReject = (id: string) => this.rejectUser(id);
        window.adminSetRole = (id: string, role: 'ADMIN' | 'MEMBER') => this.setRole(id, role);
        window.adminDeleteUser = (id: string, name: string) => this.deleteUser(id, name);
        window.adminDeleteItem = (id: string, name: string) => this.promptDeleteItem(id, name);

        window.adminApproveHardware = (id: string) => this.approveHardware(id);
        window.adminRejectHardware = (id: string) => this.rejectHardware(id);
    }

    static async loadUsers(force = false) {
        const token = localStorage.getItem('cicr_token');
        if (!token) return;

        try {
            const res = await fetch(`${API_BASE}/auth/admin/users${force ? '?force=true' : ''}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                const result = await res.json();
                this.users = result.data || [];
            }
        } catch (err) {
            console.error('Failed to fetch admin users:', err);
        }

        // Ensure All Admins have full Master Admin powers in directory
        const masterDefaults: AdminUserRecord[] = [
            {
                id: 'master-vardaan',
                name: 'Vardaan Saxena',
                email: '992501030399@mail.jiit.ac.in',
                roll_number: '992501030399',
                role: 'ADMIN',
                status: 'APPROVED',
                isMasterAdmin: true,
                created_at: '2026-09-08T17:01:03.000Z'
            },
            {
                id: 'master-vardaan-owner',
                name: 'Vardaan (Owner)',
                email: 'vardaansaxena096@gmail.com',
                roll_number: null,
                role: 'ADMIN',
                status: 'APPROVED',
                isMasterAdmin: true,
                created_at: '2026-09-08T17:01:03.000Z'
            },
            {
                id: 'master-gunjan',
                name: 'Gunjan Pal',
                email: '992401210050@mail.jiit.ac.in',
                roll_number: '992401210050',
                role: 'ADMIN',
                status: 'APPROVED',
                isMasterAdmin: true,
                batch: 'Management Head',
                created_at: '2026-09-08T17:00:00.000Z'
            },
            {
                id: 'master-dhruvi',
                name: 'Dhruvi Gupta',
                email: '992401030123@mail.jiit.ac.in',
                roll_number: '992401030123',
                role: 'ADMIN',
                status: 'APPROVED',
                isMasterAdmin: true,
                batch: 'Management Head',
                created_at: '2026-09-08T17:00:00.000Z'
            },
            {
                id: 'master-aryan',
                name: 'Aryan Varshney',
                email: '992401030154@mail.jiit.ac.in',
                roll_number: '992401030154',
                role: 'ADMIN',
                status: 'APPROVED',
                isMasterAdmin: true,
                batch: 'COORDINATOR',
                created_at: '2026-09-08T17:00:00.000Z'
            },
            {
                id: 'master-cicr',
                name: 'CICR Admin',
                email: 'cicrinventory@gmail.com',
                roll_number: null,
                role: 'ADMIN',
                status: 'APPROVED',
                isMasterAdmin: true,
                created_at: '2026-09-08T17:00:01.000Z'
            }
        ];

        for (const m of masterDefaults) {
            const existing = this.users.find(u => u.email.toLowerCase() === m.email.toLowerCase());
            if (existing) {
                existing.role = 'ADMIN';
                existing.status = 'APPROVED';
                existing.isMasterAdmin = true;
                if (!existing.name || existing.name === 'Anonymous') existing.name = m.name;
                if (!existing.batch && m.batch) existing.batch = m.batch;
            } else {
                this.users.push(m);
            }
        }

        this.users.forEach(u => {
            if (u.role === 'ADMIN' || ModalManager.isDesignatedAdminUser(u.email, u.name, u.username)) {
                u.role = 'ADMIN';
                u.status = 'APPROVED';
                u.isMasterAdmin = true;
            }
        });


        this.updateStats();
        this.renderPendingQueue(force);

        const searchInput = document.getElementById('admin-users-search') as HTMLInputElement;
        const query = searchInput ? searchInput.value : '';
        this.renderUsersTable(this.filterUsers(query), force);
    }

    static getHandledRequestIds(): Set<string> {
        try {
            const raw = localStorage.getItem('cicr_dismissed_requests');
            const set = new Set<string>(raw ? JSON.parse(raw) : []);
            set.add('req_1789341756703_7d6b6494');
            return set;
        } catch {
            return new Set(['req_1789341756703_7d6b6494']);
        }
    }

    static getRequestCanonicalKey(r: any): string {
        if (!r) return '';
        const isReturn = r.type === 'RETURN' || Boolean(r.borrowId);
        if (isReturn) {
            const bId = (r.borrowId || r.id || '').trim();
            return `ret__${bId}`;
        }
        const email = (r.borrowerEmail || r.email || '').toLowerCase().trim();
        const name = (r.borrowerName || r.name || '').toLowerCase().trim();
        const itemId = (r.itemId || '').toLowerCase().trim();
        const qty = Number(r.quantity || r.qty) || 1;
        const purpose = (r.purpose || '').toLowerCase().trim();
        const reqTime = r.requestedAt ? new Date(r.requestedAt).getTime() : 0;
        const timeBucket = reqTime > 0 ? Math.floor(reqTime / 120000) : 0;
        return `iss__${email}__${name}__${itemId}__${qty}__${purpose}__${timeBucket}`;
    }

    static markRequestHandled(...ids: (string | undefined | null)[]) {
        try {
            const raw = localStorage.getItem('cicr_dismissed_requests');
            const list: string[] = raw ? JSON.parse(raw) : [];
            let changed = false;
            for (const id of ids) {
                if (id && typeof id === 'string' && !list.includes(id)) {
                    list.push(id);
                    changed = true;
                }
            }
            if (changed) {
                if (list.length > 300) list.splice(0, list.length - 300);
                localStorage.setItem('cicr_dismissed_requests', JSON.stringify(list));
            }
        } catch { }
    }

    static async loadHardwareRequests(force = false) {
        const token = localStorage.getItem('cicr_token');
        if (!token) return;

        const handledIds = this.getHandledRequestIds();
        let serverList: AdminHardwareRequest[] = [];

        // 1. Fetch from hardware requests endpoint (backend merges local requests & Supabase pending records)
        try {
            const res = await fetch(`${API_BASE}/borrow/requests${force ? '?force=true' : ''}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                const result = await res.json();
                serverList = result.data || [];
            }
        } catch (err) {
            console.error('Failed to fetch hardware requests:', err);
        }

        // 2. Collect from local requests state and localStorage
        const localStoredRaw = localStorage.getItem('cicr_requests');
        let localRequests: RequestRecord[] = [];
        if (localStoredRaw) {
            try { localRequests = JSON.parse(localStoredRaw); } catch { }
        }
        const combinedLocal = [...(requests || []), ...localRequests];
        const localPending: AdminHardwareRequest[] = combinedLocal
            .filter((r) => r.status === 'PENDING')
            .map((r) => ({
                id: r.id,
                type: (r as any).type || ((r as any).borrowId ? 'RETURN' : 'ISSUE'),
                borrowId: (r as any).borrowId,
                returnQuantity: (r as any).returnQuantity,
                itemId: r.itemId,
                itemName: r.itemName,
                borrowerName: r.name,
                borrowerEmail: (r as any).email || (r as any).borrowerEmail || (r.roll ? `${r.roll}@mail.jiit.ac.in` : 'student@mail.jiit.ac.in'),
                rollNumber: r.roll || null,
                quantity: Number(r.qty) || 1,
                purpose: r.purpose || 'Testing',
                durationDays: 7,
                dueDate: r.dueDate || '7 Days',
                status: 'PENDING' as const,
                requestedAt: r.requestedAt || new Date().toISOString()
            }));

        const isItemDismissed = (item: any): boolean => {
            if (!item) return true;
            if (handledIds.has(item.id)) return true;
            if (item.borrowId && handledIds.has(item.borrowId)) return true;
            const key = this.getRequestCanonicalKey(item);
            if (key && handledIds.has(key)) return true;
            return false;
        };

        const canonicalQueue = new Map<string, AdminHardwareRequest>();

        // 1. Process server list first (canonical source of truth)
        for (const item of serverList) {
            if (!item || item.status !== 'PENDING') continue;
            if (isItemDismissed(item)) continue;
            const key = this.getRequestCanonicalKey(item) || item.id;
            if (!canonicalQueue.has(key)) {
                canonicalQueue.set(key, item);
            }
        }

        // 2. Add localPending items ONLY if they are not already in the canonical queue
        for (const item of localPending) {
            if (!item || item.status !== 'PENDING') continue;
            if (isItemDismissed(item)) continue;
            const key = this.getRequestCanonicalKey(item) || item.id;
            if (!canonicalQueue.has(key)) {
                canonicalQueue.set(key, item);
            }
        }

        this.hardwareRequests = Array.from(canonicalQueue.values());
        this.updateStats();
        this.renderHardwareQueue(force);
        DatabaseManager.updateNotificationBadges();
    }

    private static updateStats() {
        const pendingUsers = this.users.filter(u => u.status === 'PENDING').length;
        const pendingHardware = this.hardwareRequests.filter(r => r.status === 'PENDING').length;
        const approved = this.users.filter(u => u.status === 'APPROVED').length;
        const admins = this.users.filter(u => u.role === 'ADMIN').length;

        const statPendingUsers = document.getElementById('admin-stat-pending');
        const statPendingHw = document.getElementById('admin-stat-hw-pending');
        const statApproved = document.getElementById('admin-stat-approved');
        const statAdmins = document.getElementById('admin-stat-admins');
        const pendingTag = document.getElementById('admin-pending-count-tag');
        const hwTag = document.getElementById('admin-hw-count-tag');
        const sidebarBadge = document.getElementById('admin-pending-badge');

        const pUserStr = pendingUsers.toString();
        const pHwStr = pendingHardware.toString();
        const appStr = approved.toString();
        const admStr = admins.toString();
        const pTagStr = `${pendingUsers} PENDING`;
        const hwTagStr = `${pendingHardware} PENDING`;

        if (statPendingUsers && statPendingUsers.innerText !== pUserStr) statPendingUsers.innerText = pUserStr;
        if (statPendingHw && statPendingHw.innerText !== pHwStr) statPendingHw.innerText = pHwStr;
        if (statApproved && statApproved.innerText !== appStr) statApproved.innerText = appStr;
        if (statAdmins && statAdmins.innerText !== admStr) statAdmins.innerText = admStr;
        if (pendingTag && pendingTag.innerText !== pTagStr) pendingTag.innerText = pTagStr;
        if (hwTag && hwTag.innerText !== hwTagStr) hwTag.innerText = hwTagStr;

        const totalPending = pendingUsers + pendingHardware;
        if (sidebarBadge) {
            if (totalPending > 0) {
                if (sidebarBadge.style.display !== 'inline-block') sidebarBadge.style.display = 'inline-block';
                if (sidebarBadge.innerText !== totalPending.toString()) sidebarBadge.innerText = totalPending.toString();
            } else {
                if (sidebarBadge.style.display !== 'none') sidebarBadge.style.display = 'none';
            }
        }
    }

    private static renderHardwareQueue(force = false) {
        const container = document.getElementById('admin-hardware-list');
        if (!container) return;

        const pendingRequests = this.hardwareRequests.filter(r => r.status === 'PENDING');
        const fingerprint = pendingRequests.map(r => `${r.id}_${r.status}_${r.quantity}_${r.returnQuantity || ''}_${r.borrowerEmail}_${r.itemName}_${r.type || ''}`).join('|');

        if (!force && this.lastHardwareQueueFingerprint === fingerprint && container.children.length === (pendingRequests.length === 0 ? 1 : pendingRequests.length)) {
            return;
        }
        this.lastHardwareQueueFingerprint = fingerprint;

        if (pendingRequests.length === 0) {
            container.innerHTML = `
                <div class="admin-empty-state">
                    <i data-lucide="package-check"></i>
                    <p>No pending component requests in queue. Vault operations nominal.</p>
                </div>
            `;
            renderLucideIcons(container);
            return;
        }

        container.innerHTML = pendingRequests.map(r => {
            const isReturn = r.type === 'RETURN';
            const returnQty = Number(r.returnQuantity || r.quantity) || 1;
            return `
            <div class="hardware-request-card glass" data-request-id="${r.id}">
                <div class="hw-card-header">
                    <div class="hw-card-chip">
                        <i data-lucide="${isReturn ? 'corner-up-left' : 'cpu'}" style="width:14px; height:14px; color:var(--neon-cyan);"></i>
                        <span class="hw-item-name">${r.itemName}</span>
                    </div>
                    <span class="hw-qty-badge">${isReturn ? 'RETURN' : 'ISSUE'} · ${isReturn ? returnQty : r.quantity}x</span>
                </div>

                <div class="hw-card-requester">
                    <div class="hw-avatar">${r.borrowerName.charAt(0).toUpperCase()}</div>
                    <div class="hw-meta-col">
                        <span class="hw-requester-name">${r.borrowerName}</span>
                        <span class="hw-requester-email">${r.borrowerEmail}</span>
                    </div>
                </div>

                <div class="hw-card-details">
                    ${r.rollNumber ? `<div class="hw-detail-row"><span class="hw-lbl">ROLL:</span> <span class="hw-val mono">${r.rollNumber}</span></div>` : ''}
                    ${isReturn
                    ? `<div class="hw-detail-row"><span class="hw-lbl">RETURNING:</span> <span class="hw-val">${returnQty}x ${r.itemName}</span></div>`
                    : `<div class="hw-detail-row"><span class="hw-lbl">PURPOSE:</span> <span class="hw-val">${r.purpose}</span></div>`}
                    ${isReturn ? '' : `<div class="hw-detail-row"><span class="hw-lbl">DUE DATE:</span> <span class="hw-val due">${r.dueDate || '7 Days'}</span></div>`}
                    <div class="hw-detail-row"><span class="hw-lbl">REQUESTED:</span> <span class="hw-val date">${new Date(r.requestedAt).toLocaleString()}</span></div>
                </div>

                <div class="hw-card-actions">
                    <button class="btn-hw-approve" onclick="window.adminApproveHardware('${r.id}')">
                        <i data-lucide="check"></i> ${isReturn ? 'Approve Return' : 'Approve Issue'}
                    </button>
                    <button class="btn-hw-reject" onclick="window.adminRejectHardware('${r.id}')">
                        <i data-lucide="x"></i> Reject
                    </button>
                </div>
            </div>
        `;
        }).join('');

        renderLucideIcons(container);
    }

    private static pendingActionIds = new Set<string>();

    static async approveHardware(id: string) {
        if (this.pendingActionIds.has(id)) return;
        this.pendingActionIds.add(id);
        setTimeout(() => this.pendingActionIds.delete(id), 2500);

        const token = localStorage.getItem('cicr_token');
        const targetReq = this.hardwareRequests.find(r => r.id === id)
            || (requests.find(r => r.id === id) as any);
        const reqSnapshot = targetReq ? { ...targetReq } : null;
        const targetKey = this.getRequestCanonicalKey(targetReq);

        const matchesTarget = (r: any): boolean => {
            if (!r) return false;
            if (r.id === id) return true;
            if (targetReq?.id && r.id === targetReq.id) return true;
            if (targetReq?.borrowId && (r.borrowId === targetReq.borrowId || r.id === targetReq.borrowId)) return true;
            if (r.borrowId && (r.borrowId === id || r.id === id)) return true;
            if (targetKey) {
                const k = AdminManager.getRequestCanonicalKey(r);
                if (k && k === targetKey) return true;
            }
            return false;
        };

        // Permanently record as handled so it NEVER resurrects in UI
        this.markRequestHandled(id, targetReq?.id, targetReq?.borrowId, targetKey);

        // 1. INSTANT 1-CLICK OPTIMISTIC UI UPDATE (Zero Latency)
        this.hardwareRequests = this.hardwareRequests.filter(r => !matchesTarget(r));
        requests = requests.filter(r => !matchesTarget(r));
        this.updateStats();
        this.renderHardwareQueue(true);

        // Immediately purge from localStorage
        const localStoredRaw = localStorage.getItem('cicr_requests');
        if (localStoredRaw) {
            try {
                const parsed = JSON.parse(localStoredRaw);
                const filtered = parsed.filter((r: any) => !matchesTarget(r));
                localStorage.setItem('cicr_requests', JSON.stringify(filtered));
            } catch { }
        }
        DatabaseManager.save();
        DatabaseManager.updateNotificationBadges();

        const isReturnReq = reqSnapshot?.type === 'RETURN' || Boolean(reqSnapshot?.borrowId);
        ToastManager.show(
            isReturnReq ? 'Return Authorized' : 'Request Authorized',
            `${isReturnReq ? 'Return' : 'Component issue'} for "${reqSnapshot?.itemName || 'Hardware'}" approved.`,
            'success'
        );
        DatabaseManager.addLog('approve', `Admin authorized ${isReturnReq ? 'return' : 'hardware issue'} request #${id.slice(0, 8)}`);

        // 2. Perform background sync to server
        try {
            const res = await fetch(`${API_BASE}/borrow/requests/${id}/approve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(reqSnapshot || {})
            });

            if (!res.ok) {
                // If backend couldn't decrement stock (e.g. unlisted/mock item), tell backend to mark/clear the request
                await fetch(`${API_BASE}/borrow/requests/${id}/reject`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ reason: 'Approved offline / unlisted inventory item.' })
                }).catch(() => { });
            }
        } catch (e) {
            console.warn('Background approval sync note:', e);
        }

        // Non-blocking telemetry refresh in background
        this.loadAuditLogs();
        DatabaseManager.syncFromBackend();
    }

    static async rejectHardware(id: string) {
        if (this.pendingActionIds.has(id)) return;
        this.pendingActionIds.add(id);
        setTimeout(() => this.pendingActionIds.delete(id), 2500);

        const token = localStorage.getItem('cicr_token');
        const targetReq = this.hardwareRequests.find(r => r.id === id)
            || (requests.find(r => r.id === id) as any);
        const itemName = targetReq?.itemName || 'Component';
        const targetKey = this.getRequestCanonicalKey(targetReq);

        const matchesTarget = (r: any): boolean => {
            if (!r) return false;
            if (r.id === id) return true;
            if (targetReq?.id && r.id === targetReq.id) return true;
            if (targetReq?.borrowId && (r.borrowId === targetReq.borrowId || r.id === targetReq.borrowId)) return true;
            if (r.borrowId && (r.borrowId === id || r.id === id)) return true;
            if (targetKey) {
                const k = AdminManager.getRequestCanonicalKey(r);
                if (k && k === targetKey) return true;
            }
            return false;
        };

        // Permanently record as handled so it NEVER resurrects in UI
        this.markRequestHandled(id, targetReq?.id, targetReq?.borrowId, targetKey);

        // 1. INSTANT 1-CLICK OPTIMISTIC UI UPDATE (Zero Latency)
        this.hardwareRequests = this.hardwareRequests.filter(r => !matchesTarget(r));
        requests.forEach(r => {
            if (matchesTarget(r)) {
                r.status = 'REJECTED';
                r.reviewNote = 'Declined by Administrator.';
            }
        });
        this.updateStats();
        this.renderHardwareQueue(true);

        // Persist updated status to localStorage
        const localStoredRaw = localStorage.getItem('cicr_requests');
        if (localStoredRaw) {
            try {
                const parsed = JSON.parse(localStoredRaw);
                const updated = parsed.map((r: any) => matchesTarget(r) ? { ...r, status: 'REJECTED', reviewNote: 'Declined by Administrator.' } : r);
                localStorage.setItem('cicr_requests', JSON.stringify(updated));
            } catch { }
        }
        DatabaseManager.save();
        DatabaseManager.updateNotificationBadges();

        ToastManager.show('Request Declined', `Hardware issue request for "${itemName}" declined.`, 'info');
        DatabaseManager.addLog('reject', `Admin declined hardware issue request #${id.slice(0, 8)}`);

        // 2. Perform background notification to server with full borrower details guaranteed
        const reqPayload = targetReq ? {
            ...targetReq,
            reason: 'Declined by Administrator.',
            borrowerEmail: targetReq.borrowerEmail,
            borrowerName: targetReq.borrowerName,
            itemName: targetReq.itemName,
            quantity: targetReq.quantity,
            purpose: targetReq.purpose,
            type: targetReq.type,
            borrowId: targetReq.borrowId
        } : { reason: 'Declined by Administrator.' };

        try {
            await fetch(`${API_BASE}/borrow/requests/${id}/reject`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(reqPayload)
            });
        } catch (e) {
            console.warn('Background rejection sync note:', e);
        }

        this.loadAuditLogs();
        DatabaseManager.syncFromBackend();
    }

    private static renderPendingQueue(force = false) {
        const container = document.getElementById('admin-pending-list');
        if (!container) return;

        const pendingUsers = this.users.filter(u => u.status === 'PENDING');
        const fingerprint = pendingUsers.map(u => `${u.id}_${u.status}_${u.name}_${u.email}_${u.roll_number || ''}_${u.batch || ''}`).join('|');

        if (!force && this.lastPendingQueueFingerprint === fingerprint && container.children.length === (pendingUsers.length === 0 ? 1 : pendingUsers.length)) {
            return;
        }
        this.lastPendingQueueFingerprint = fingerprint;

        if (pendingUsers.length === 0) {
            container.innerHTML = `
                <div class="admin-empty-state">
                    <i data-lucide="check-circle-2"></i>
                    <p>No pending registration requests. All accounts are up to date!</p>
                </div>
            `;
            renderLucideIcons(container);
            return;
        }

        container.innerHTML = pendingUsers.map(u => {
            const dt = DashboardManager.formatLogDateTime(u.created_at);
            return `
            <div class="pending-request-card glass" data-user-id="${u.id}">
                <div class="pending-card-top">
                    <div class="pending-card-avatar">${u.name.charAt(0).toUpperCase()}</div>
                    <div class="pending-card-meta">
                        <span class="pending-card-name">${this.escapeHtml(u.name)}</span>
                        <span class="pending-card-email">${this.escapeHtml(u.email)}</span>
                    </div>
                </div>
                <div class="pending-card-extra">
                    <span><i data-lucide="calendar" style="width:11px; height:11px; vertical-align:middle;"></i> ${dt.dateStr}${dt.timeStr ? ` • ${dt.timeStr}` : ''}</span>
                    ${u.roll_number ? `<span>• Roll: ${this.escapeHtml(u.roll_number)}</span>` : ''}
                    ${u.batch ? `<span>• Batch: ${this.escapeHtml(u.batch)}</span>` : ''}
                </div>
                <div class="pending-card-actions">
                    <button class="btn-approve" onclick="window.adminApprove('${u.id}')">
                        <i data-lucide="check"></i> Approve
                    </button>
                    <button class="btn-reject" onclick="window.adminReject('${u.id}')">
                        <i data-lucide="x"></i> Reject
                    </button>
                </div>
            </div>
            `;
        }).join('');

        renderLucideIcons(container);
    }

    private static filterUsers(query: string) {
        if (!query || !query.trim()) return this.users;
        const q = query.toLowerCase().trim();
        return this.users.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }

    private static renderUsersTable(usersList: AdminUserRecord[], force = false) {
        const tbody = document.getElementById('admin-users-tbody');
        if (!tbody) return;

        const totalBadge = document.getElementById('admin-users-total-badge');
        const totalText = `${this.users.length} USERS`;
        if (totalBadge && totalBadge.innerText !== totalText) totalBadge.innerText = totalText;

        const allAdmins = this.users.filter(u => u.isMasterAdmin || u.role === 'ADMIN' || ModalManager.isDesignatedAdminUser(u.email, u.name, u.username));
        const allMembers = this.users.filter(u => !(u.isMasterAdmin || u.role === 'ADMIN' || ModalManager.isDesignatedAdminUser(u.email, u.name, u.username)));

        const pillAll = document.getElementById('pill-filter-all');
        const pillAdmin = document.getElementById('pill-filter-admin');
        const pillMember = document.getElementById('pill-filter-member');

        const allText = `ALL (${this.users.length})`;
        if (pillAll && pillAll.innerText !== allText) pillAll.innerText = allText;
        const adminText = `ADMINS (${allAdmins.length})`;
        if (pillAdmin && pillAdmin.innerText !== adminText) pillAdmin.innerText = adminText;
        const memberText = `MEMBERS (${allMembers.length})`;
        if (pillMember && pillMember.innerText !== memberText) pillMember.innerText = memberText;

        const usersFingerprint = `${this.activeUserRoleFilter}_` + usersList.map(u => `${u.id}_${u.role}_${u.status}_${u.name}_${u.email}_${u.roll_number || ''}_${u.batch || ''}`).join('|');
        if (!force && this.lastUsersTableFingerprint === usersFingerprint && tbody.children.length > 0) {
            return;
        }
        this.lastUsersTableFingerprint = usersFingerprint;

        // Separate current filtered users into Admins and Members
        const adminUsers = usersList.filter(u => u.isMasterAdmin || u.role === 'ADMIN' || ModalManager.isDesignatedAdminUser(u.email, u.name, u.username));
        const memberUsers = usersList.filter(u => !(u.isMasterAdmin || u.role === 'ADMIN' || ModalManager.isDesignatedAdminUser(u.email, u.name, u.username)));

        const renderRow = (u: AdminUserRecord): string => {
            const statusClass = u.status === 'APPROVED' ? 'approved' : u.status === 'PENDING' ? 'pending' : 'rejected';
            const isMaster = u.isMasterAdmin || u.role === 'ADMIN' || ModalManager.isDesignatedAdminUser(u.email, u.name, u.username);

            // Format registration date & time in 2 separate lines
            const dt = DashboardManager.formatLogDateTime(u.created_at);
            const dateHtml = `
                <div class="user-reg-date-wrap">
                    <span class="user-reg-date">${dt.dateStr}</span>
                    <span class="user-reg-time"><i data-lucide="clock"></i>${dt.timeStr || '--:--'}</span>
                </div>
            `;

            // Cyber avatar styles
            const avatarGradient = isMaster
                ? 'linear-gradient(135deg, #00f0ff, #facc15)'
                : u.role === 'ADMIN'
                    ? 'linear-gradient(135deg, #ff007a, #9333ea)'
                    : 'linear-gradient(135deg, #00f0ff, #3b82f6)';

            const avatarShadow = isMaster
                ? '0 0 10px rgba(0, 240, 255, 0.4), 0 0 4px rgba(250, 204, 21, 0.3)'
                : u.role === 'ADMIN'
                    ? '0 0 10px rgba(255, 0, 122, 0.35)'
                    : '0 0 8px rgba(0, 240, 255, 0.2)';

            const roleBadge = isMaster
                ? `<span class="badge-role master"><i data-lucide="crown"></i> MASTER ADMIN</span>`
                : u.role === 'ADMIN'
                    ? `<span class="badge-role admin"><i data-lucide="shield"></i> ADMIN</span>`
                    : `<span class="badge-role member"><i data-lucide="user"></i> MEMBER</span>`;

            let actionsHtml = '';
            if (isMaster) {
                actionsHtml = `<span class="badge-perm-admin"><i data-lucide="shield-check"></i> ROOT ACCESS</span>`;
            } else if (u.email.toLowerCase() === 'mahakkatahara.mk@gmail.com') {
                const deleteBtn = `<button class="btn-table-action btn-del" onclick="window.adminDeleteUser('${u.id}', '${this.escapeHtml(u.name)}')" title="Permanently Delete User"><i data-lucide="trash-2"></i></button>`;
                actionsHtml = `<span class="badge-member-only">MEMBER ONLY</span> ${deleteBtn}`;
            } else {
                const roleBtn = u.role === 'ADMIN'
                    ? `<button class="btn-table-action btn-demote" onclick="window.adminSetRole('${u.id}', 'MEMBER')" title="Demote to Member"><i data-lucide="shield-off"></i> Demote</button>`
                    : `<button class="btn-table-action btn-make-admin" onclick="window.adminSetRole('${u.id}', 'ADMIN')" title="Promote to Admin"><i data-lucide="shield-alert"></i> Make Admin</button>`;

                const deleteBtn = `<button class="btn-table-action btn-del" onclick="window.adminDeleteUser('${u.id}', '${this.escapeHtml(u.name)}')" title="Permanently Delete User"><i data-lucide="trash-2"></i></button>`;

                actionsHtml = `${roleBtn} ${deleteBtn}`;
            }

            const metaSub = u.roll_number || u.batch
                ? `<span class="user-cell-subtext">${u.roll_number ? `Roll: ${this.escapeHtml(u.roll_number)}` : ''}${u.roll_number && u.batch ? ' • ' : ''}${u.batch ? `Batch: ${this.escapeHtml(u.batch)}` : ''}</span>`
                : (u.username ? `<span class="user-cell-subtext">@${this.escapeHtml(u.username)}</span>` : '');

            return `
                <tr data-user-id="${u.id}">
                    <td>
                        <div class="user-cell-name">
                            <div class="user-cell-avatar" style="background: ${avatarGradient}; box-shadow: ${avatarShadow};">
                                ${u.name ? u.name.charAt(0).toUpperCase() : 'U'}
                            </div>
                            <div class="user-cell-meta-wrap">
                                <span class="user-cell-display-name">${this.escapeHtml(u.name || 'Anonymous')}</span>
                                ${metaSub}
                            </div>
                        </div>
                    </td>
                    <td>
                        <span class="user-email-text">${this.escapeHtml(u.email)}</span>
                    </td>
                    <td>
                        <span class="badge-status ${statusClass}">
                            <span class="status-pulse-dot dot-${statusClass}"></span>
                            ${u.status}
                        </span>
                    </td>
                    <td>${roleBadge}</td>
                    <td>${dateHtml}</td>
                    <td><div class="table-actions-cell">${actionsHtml}</div></td>
                </tr>
            `;
        };

        const renderAdminSection = (): string => {
            if (adminUsers.length === 0) {
                return `
                    <tr class="user-group-divider-row admin-group-row">
                        <td colspan="6">
                            <div class="user-group-header">
                                <div class="user-group-title">
                                    <i data-lucide="crown"></i>
                                    <span>ADMINISTRATORS & LEADERSHIP</span>
                                </div>
                                <span class="user-group-badge badge-cyan">0 ADMINS</span>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 20px; color: var(--text-dim); font-size: 11px;">
                            No administrators found matching criteria.
                        </td>
                    </tr>
                `;
            }

            return `
                <tr class="user-group-divider-row admin-group-row">
                    <td colspan="6">
                        <div class="user-group-header">
                            <div class="user-group-title">
                                <i data-lucide="crown"></i>
                                <span>ADMINISTRATORS & LEADERSHIP</span>
                            </div>
                            <span class="user-group-badge badge-cyan">${adminUsers.length} ADMINS</span>
                        </div>
                    </td>
                </tr>
                ${adminUsers.map(renderRow).join('')}
            `;
        };

        const renderMemberSection = (): string => {
            if (memberUsers.length === 0) {
                return `
                    <tr class="user-group-divider-row member-group-row">
                        <td colspan="6">
                            <div class="user-group-header">
                                <div class="user-group-title">
                                    <i data-lucide="users"></i>
                                    <span>REGISTERED MEMBERS & STUDENTS</span>
                                </div>
                                <span class="user-group-badge badge-purple">0 MEMBERS</span>
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="6" style="text-align: center; padding: 20px; color: var(--text-dim); font-size: 11px;">
                            No registered members found matching criteria.
                        </td>
                    </tr>
                `;
            }

            return `
                <tr class="user-group-divider-row member-group-row">
                    <td colspan="6">
                        <div class="user-group-header">
                            <div class="user-group-title">
                                <i data-lucide="users"></i>
                                <span>REGISTERED MEMBERS & STUDENTS</span>
                            </div>
                            <span class="user-group-badge badge-purple">${memberUsers.length} MEMBERS</span>
                        </div>
                    </td>
                </tr>
                ${memberUsers.map(renderRow).join('')}
            `;
        };

        if (usersList.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; padding: 32px; color: var(--text-dim); font-family: 'Orbitron', sans-serif; font-size: 11px;">
                        <i data-lucide="shield-alert" style="width:20px;height:20px;display:block;margin:0 auto 8px auto;color:#64748b;"></i>
                        No users matching search criteria.
                    </td>
                </tr>
            `;
            renderLucideIcons(tbody);
            return;
        }

        if (this.activeUserRoleFilter === 'admin') {
            tbody.innerHTML = renderAdminSection();
        } else if (this.activeUserRoleFilter === 'member') {
            tbody.innerHTML = renderMemberSection();
        } else {
            tbody.innerHTML = renderAdminSection() + renderMemberSection();
        }

        renderLucideIcons(tbody);
    }

    static async approveUser(id: string) {
        const token = localStorage.getItem('cicr_token');
        const targetUser = this.users.find(u => u.id === id);
        const userName = targetUser?.name || id;
        const userEmail = targetUser?.email || '';

        // 1. INSTANT 1-CLICK OPTIMISTIC UI UPDATE
        if (targetUser) {
            targetUser.status = 'APPROVED';
        }
        this.updateStats();
        this.renderPendingQueue(true);
        const searchInput = document.getElementById('admin-users-search') as HTMLInputElement;
        this.renderUsersTable(this.filterUsers(searchInput ? searchInput.value : ''), true);

        ToastManager.show('User Approved', `Member "${userName}" has been granted access.`, 'success');
        DatabaseManager.addLog('system', `Admin approved membership for ${userName} (${userEmail})`);

        // 2. Background sync to server
        try {
            await fetch(`${API_BASE}/auth/admin/users/${id}/approve`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        } catch (e) {
            console.warn('Background user approval note:', e);
        }

        this.loadAuditLogs();
        DatabaseManager.updateNotificationBadges();
    }

    static async rejectUser(id: string) {
        const token = localStorage.getItem('cicr_token');
        const targetUser = this.users.find(u => u.id === id);
        const userName = targetUser?.name || id;

        // 1. INSTANT 1-CLICK OPTIMISTIC UI UPDATE
        if (targetUser) {
            targetUser.status = 'REJECTED';
        }
        this.updateStats();
        this.renderPendingQueue(true);
        const searchInput = document.getElementById('admin-users-search') as HTMLInputElement;
        this.renderUsersTable(this.filterUsers(searchInput ? searchInput.value : ''), true);

        ToastManager.show('User Rejected', `Membership request for "${userName}" declined.`, 'warning');
        DatabaseManager.addLog('system', `Admin rejected membership request for ${userName}`);

        // 2. Background sync to server
        try {
            await fetch(`${API_BASE}/auth/admin/users/${id}/reject`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        } catch (e) {
            console.warn('Background user rejection note:', e);
        }

        this.loadAuditLogs();
        DatabaseManager.updateNotificationBadges();
    }

    static async setRole(id: string, role: 'ADMIN' | 'MEMBER') {
        const token = localStorage.getItem('cicr_token');
        try {
            const res = await fetch(`${API_BASE}/auth/admin/users/${id}/role`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ role })
            });
            if (res.ok) {
                ToastManager.show('Role Updated', `User permissions changed to ${role}.`, 'info');
                DatabaseManager.addLog('system', `User ${id} role updated to ${role}`);
                await this.loadUsers(true);
                await this.loadAuditLogs();
            } else {
                const err = await res.json().catch(() => ({}));
                ToastManager.show('Update Failed', err.message || 'Could not update user role', 'error');
            }
        } catch (e) {
            console.error('Error changing role:', e);
            ToastManager.show('Network Error', 'Failed to update user role', 'error');
        }
    }

    static async deleteUser(id: string, name: string) {
        if (!confirm(`Are you sure you want to permanently delete user "${name}"?\n\nThis will remove their profile, credentials, and all records from the database permanently.`)) return;
        const token = localStorage.getItem('cicr_token');
        try {
            // Optimistically update local view immediately
            this.users = this.users.filter(u => u.id !== id);
            const searchInput = document.getElementById('admin-users-search') as HTMLInputElement;
            this.renderUsersTable(this.filterUsers(searchInput?.value || ''), true);
            this.renderPendingQueue(true);
            this.updateStats();

            const res = await fetch(`${API_BASE}/auth/admin/users/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                ToastManager.show('User Deleted', `User "${name}" has been permanently deleted from the database.`, 'warning');
                DatabaseManager.addLog('system', `Admin deleted user profile "${name}" (${id})`);
                await this.loadUsers();
                await this.loadAuditLogs();
                DatabaseManager.updateNotificationBadges();
            } else {
                const err = await res.json().catch(() => ({}));
                ToastManager.show('Delete Failed', err.message || 'Could not delete user from database', 'error');
                await this.loadUsers();
            }
        } catch (e) {
            console.error('Error deleting user:', e);
            ToastManager.show('Network Error', 'Failed to communicate with database server', 'error');
            await this.loadUsers();
        }
    }

    static promptDeleteItem(itemId: string, itemName: string) {
        const modal = document.getElementById('delete-confirm-modal');
        const targetName = document.getElementById('delete-item-target-name');
        const confirmBtn = document.getElementById('btn-confirm-delete') as HTMLButtonElement;
        const cancelBtn = document.getElementById('btn-cancel-delete');
        const closeBtn = document.getElementById('close-delete-confirm');

        if (!modal) return;
        if (targetName) targetName.innerText = itemName;

        modal.style.removeProperty('display');
        modal.classList.add('active');

        const closeModal = () => {
            modal.classList.remove('active');
        };

        if (cancelBtn) cancelBtn.onclick = closeModal;
        if (closeBtn) closeBtn.onclick = closeModal;
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                confirmBtn.disabled = true;
                confirmBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Deleting...';
                try {
                    const token = localStorage.getItem('cicr_token');
                    const res = await fetch(`${API_BASE}/items/${itemId}`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    const json = await res.json();
                    if (res.ok) {
                        // 1. Immediately remove item from local state & cache
                        inventory = inventory.filter(it => it.id !== itemId && String(it.id) !== String(itemId));
                        DatabaseManager.save();

                        // 2. If detail modal is open for this item, close it
                        if (selectedItem && (selectedItem.id === itemId || String(selectedItem.id) === String(itemId))) {
                            ModalManager.closeAll();
                        }

                        // 3. Close the delete confirm modal
                        closeModal();

                        // 4. Force re-render inventory grid and stats instantly
                        if (window.dashboard) {
                            window.dashboard.renderInventory(true);
                            window.dashboard.renderStats();
                        }

                        ToastManager.show('Item Removed', `"${itemName}" was permanently deleted from the vault.`, 'warning');

                        // 5. Sync from backend and update audit logs
                        await DatabaseManager.syncFromBackend();
                        await AdminManager.loadAuditLogs();
                        DatabaseManager.updateNotificationBadges();
                    } else {
                        ToastManager.show('Delete Error', json.message || 'Failed to delete item.', 'error');
                    }
                } catch (err: any) {
                    console.error('Delete item error:', err);
                    ToastManager.show('Network Error', 'Failed to reach backend API.', 'error');
                } finally {
                    confirmBtn.disabled = false;
                    confirmBtn.innerHTML = '<i data-lucide="trash-2"></i> Confirm Delete';
                    lucide.createIcons();
                }
            };
        }
        lucide.createIcons();
    }

    static activeAuditDay: string = 'all';
    static activeAuditDaysRange: number = 7;
    static auditTelemetry: any = null;

    static async loadAuditLogs(resetToFull7Days = false) {
        const token = localStorage.getItem('cicr_token');
        if (!token) return;

        if (resetToFull7Days) {
            this.activeAuditDay = 'all';
            this.activeAuditDaysRange = 7;
            this.activeAuditCategory = 'all';

            // Reset category and range pills in UI
            document.querySelectorAll('#admin-audit-pills .audit-pill').forEach(p => {
                p.classList.toggle('active', (p as HTMLElement).dataset.auditCat === 'all');
            });
            document.querySelectorAll('#admin-audit-range-pills .audit-range-pill').forEach(p => {
                p.classList.toggle('active', p.getAttribute('data-range-days') === '7');
            });
        }

        try {
            let url = `${API_BASE}/audit?days=${this.activeAuditDaysRange}&limit=2500&category=${this.activeAuditCategory}`;
            if (this.activeAuditDay && this.activeAuditDay !== 'all') {
                url += `&day=${this.activeAuditDay}`;
            }

            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const json = await res.json();
                this.auditLogs = json.data || [];
                this.auditTelemetry = json;

                this.updateAuditCategoryPills(json.categoryCounts);
                this.renderAuditLogs();

                // Synchronize notifications drawer system tab if currently active
                if (ModalManager.activeNotifTab === 'system') {
                    ModalManager.renderLogsDrawer();
                }
            }
        } catch (err) {
            console.warn('[ADMIN] Failed to load 7-day audit logs:', err);
        }
    }

    static updateAuditCategoryPills(counts?: any) {
        if (!counts) return;
        const setCnt = (id: string, val: number) => {
            const el = document.getElementById(id);
            if (el) el.innerText = String(val || 0);
        };
        setCnt('cat-cnt-all', counts.all || 0);
        setCnt('cat-cnt-auth', counts.auth || 0);
        setCnt('cat-cnt-inventory', counts.inventory || 0);
        setCnt('cat-cnt-hardware', counts.hardware || 0);
        setCnt('cat-cnt-loans', counts.loans || 0);
        setCnt('cat-cnt-system', counts.system || 0);
    }

    static renderAuditSpectrum(_dailyCounts?: any) {
        // Spectrum section removed per design update request (Photo 1)
    }

    static renderAuditLogs() {
        const container = document.getElementById('admin-audit-stream');
        const countTag = document.getElementById('admin-audit-count-tag');
        const totalStat = document.getElementById('admin-stat-total-logs');
        if (!container) return;

        // 1. Time range filtering (1d = 24h, 3d = 72h, 7d = all 7 days)
        const now = Date.now();
        const maxAgeMs = (this.activeAuditDaysRange && this.activeAuditDaysRange < 7)
            ? (this.activeAuditDaysRange * 24 * 60 * 60 * 1000)
            : Infinity;

        const rangeFilteredLogs = this.auditLogs.filter(l => {
            if (!l.timestamp || maxAgeMs === Infinity) return true;
            const logTime = new Date(l.timestamp).getTime();
            return !isNaN(logTime) && (now - logTime) <= maxAgeMs;
        });

        // Compute and update category badge counts for the active time window
        const catCounts = {
            all: rangeFilteredLogs.length,
            auth: 0,
            inventory: 0,
            hardware: 0,
            loans: 0,
            system: 0
        };

        rangeFilteredLogs.forEach(l => {
            const act = l.action || '';
            if (['Sign In', 'Sign Up', 'User Approved', 'User Rejected', 'Role Changed', 'User Deleted', 'Password Reset'].includes(act)) {
                catCounts.auth++;
            } else if (['Item Added', 'Item Edited', 'Item Deleted', 'Stock Alert', 'Low Stock'].includes(act)) {
                catCounts.inventory++;
            } else if (['Hardware Requested', 'Hardware Approved', 'Hardware Rejected', 'Hardware Cancelled'].includes(act)) {
                catCounts.hardware++;
            } else if (['Borrowed', 'Returned', 'OTP Requested', 'Item Borrowed', 'Item Returned', 'Approved Return', 'Return Requested'].includes(act)) {
                catCounts.loans++;
            } else {
                catCounts.system++;
            }
        });
        this.updateAuditCategoryPills(catCounts);

        // 2. Category filtering
        let filtered = rangeFilteredLogs;
        if (this.activeAuditCategory && this.activeAuditCategory !== 'all') {
            const cat = this.activeAuditCategory.toLowerCase();
            filtered = filtered.filter(l => {
                const act = l.action || '';
                if (cat === 'auth') {
                    return ['Sign In', 'Sign Up', 'User Approved', 'User Rejected', 'Role Changed', 'User Deleted', 'Password Reset'].includes(act);
                } else if (cat === 'inventory') {
                    return ['Item Added', 'Item Edited', 'Item Deleted', 'Stock Alert', 'Low Stock'].includes(act);
                } else if (cat === 'hardware') {
                    return ['Hardware Requested', 'Hardware Approved', 'Hardware Rejected', 'Hardware Cancelled'].includes(act);
                } else if (cat === 'loans') {
                    return ['Borrowed', 'Returned', 'OTP Requested', 'Item Borrowed', 'Item Returned', 'Approved Return', 'Return Requested'].includes(act);
                } else if (cat === 'system') {
                    return !['Sign In', 'Sign Up', 'User Approved', 'User Rejected', 'Role Changed', 'User Deleted', 'Password Reset',
                             'Item Added', 'Item Edited', 'Item Deleted', 'Stock Alert', 'Low Stock',
                             'Hardware Requested', 'Hardware Approved', 'Hardware Rejected', 'Hardware Cancelled',
                             'Borrowed', 'Returned', 'OTP Requested', 'Item Borrowed', 'Item Returned', 'Approved Return', 'Return Requested'].includes(act);
                }
                return true;
            });
        }

        // 3. Search Term filtering
        if (this.auditSearchTerm) {
            filtered = filtered.filter(l =>
                (l.action && l.action.toLowerCase().includes(this.auditSearchTerm)) ||
                (l.description && l.description.toLowerCase().includes(this.auditSearchTerm)) ||
                (l.users?.name && l.users.name.toLowerCase().includes(this.auditSearchTerm)) ||
                (l.users?.email && l.users.email.toLowerCase().includes(this.auditSearchTerm)) ||
                (l.inventory?.name && l.inventory.name.toLowerCase().includes(this.auditSearchTerm))
            );
        }

        if (countTag) countTag.innerText = `${filtered.length} EVENTS`;
        if (totalStat) totalStat.innerText = String(rangeFilteredLogs.length);

        if (filtered.length === 0) {
            container.innerHTML = `
                <div class="admin-empty-state">
                    <i data-lucide="check-circle-2"></i>
                    <p>No audit log events found matching the criteria in the 7-day retention window.</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        container.innerHTML = filtered.map(log => {
            const action = log.action || 'System Event';
            let badgeClass = 'action-cyan';
            let iconName = 'activity';
            let cardCat = 'cat-system';

            if (['Item Added', 'Hardware Approved', 'User Approved', 'Returned', 'Item Returned', 'Approved Return'].includes(action)) {
                badgeClass = 'action-green';
                iconName = 'check-circle';
                cardCat = 'cat-inventory';
            } else if (['Item Deleted', 'Hardware Rejected', 'User Rejected', 'User Deleted'].includes(action)) {
                badgeClass = 'action-red';
                iconName = 'alert-octagon';
                cardCat = 'cat-danger';
            } else if (['Sign In', 'Sign Up', 'Role Changed', 'Password Reset'].includes(action)) {
                badgeClass = 'action-purple';
                iconName = action === 'Sign In' ? 'log-in' : action === 'Password Reset' ? 'key' : 'user-plus';
                cardCat = 'cat-auth';
            } else if (['Borrowed', 'Item Borrowed', 'Hardware Requested'].includes(action)) {
                badgeClass = 'action-yellow';
                iconName = 'package';
                cardCat = 'cat-loans';
            } else if (['Item Edited', 'Stock Alert'].includes(action)) {
                badgeClass = 'action-cyan';
                iconName = 'cpu';
                cardCat = 'cat-inventory';
            }

            const rawTime = log.timestamp || log.created_at || new Date().toISOString();
            const dt = DashboardManager.formatLogDateTime(rawTime);
            const timeAgo = this.formatTimeAgo(rawTime);

            const actorName = log.users?.name || (log.user_id ? 'Member' : 'System');
            const actorEmail = log.users?.email || '';

            return `
                <div class="audit-log-card ${cardCat}" onclick="window.openAuditDetail('${log.id}')" title="Click to view raw event telemetry metadata">
                    <div class="audit-left-col">
                        <span class="audit-action-badge ${badgeClass}">
                            <i data-lucide="${iconName}" style="width: 11px; height: 11px;"></i>
                            ${action}
                        </span>
                        <div class="audit-content-block">
                            <span class="audit-desc-text">${this.escapeHtml(log.description || 'Action recorded')}</span>
                            <div class="audit-meta-chips">
                                <span class="audit-actor-chip"><i data-lucide="user" style="width: 11px; height: 11px;"></i> <strong>${actorName}</strong> ${actorEmail ? `(${actorEmail})` : ''}</span>
                                ${log.inventory?.name ? `<span class="audit-actor-chip" style="color: #00f0ff;"><i data-lucide="box" style="width: 11px; height: 11px;"></i> ${log.inventory.name}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="audit-right-col">
                        <span class="audit-date-line">${dt.dateStr}</span>
                        <span class="audit-time-line">${dt.timeStr} <span class="audit-ago-sub">(${timeAgo})</span></span>
                    </div>
                </div>
            `;
        }).join('');

        renderLucideIcons(container);
    }

    static openAuditDetail(logId: string) {
        const log = this.auditLogs.find(l => l.id === logId);
        if (!log) return;

        const modal = document.getElementById('audit-detail-modal');
        if (!modal) return;

        const badgeEl = document.getElementById('audit-modal-badge');
        const timeEl = document.getElementById('audit-modal-time');
        const actorEl = document.getElementById('audit-modal-actor');
        const emailEl = document.getElementById('audit-modal-email');
        const itemEl = document.getElementById('audit-modal-item');
        const isoEl = document.getElementById('audit-modal-iso');
        const descEl = document.getElementById('audit-modal-desc');
        const jsonEl = document.getElementById('audit-modal-json');

        const rawTime = log.timestamp || log.created_at || new Date().toISOString();
        const dt = DashboardManager.formatLogDateTime(rawTime);
        const timeAgo = this.formatTimeAgo(rawTime);

        if (badgeEl) badgeEl.innerText = log.action || 'SYSTEM EVENT';
        if (timeEl) timeEl.innerText = `${dt.dateStr} ${dt.timeStr} (${timeAgo})`;
        if (actorEl) actorEl.innerText = log.users?.name || (log.user_id ? 'Authenticated Member' : 'System Engine');
        if (emailEl) emailEl.innerText = log.users?.email || '—';
        if (itemEl) itemEl.innerText = log.inventory?.name || (log.item_id || '—');
        if (isoEl) isoEl.innerText = rawTime;
        if (descEl) descEl.innerText = log.description || 'No detailed description available.';
        if (jsonEl) jsonEl.innerText = JSON.stringify(log, null, 2);

        modal.classList.add('active');
        renderLucideIcons(modal);
    }

    static exportAuditLogsCSV() {
        if (!this.auditLogs || this.auditLogs.length === 0) {
            ToastManager.show('Export Empty', 'No audit logs available to export.', 'warning');
            return;
        }

        const headers = ['Timestamp', 'Action', 'Actor Name', 'Actor Email', 'Target Item', 'Description'];
        const rows = this.auditLogs.map(l => [
            `"${l.timestamp || ''}"`,
            `"${(l.action || '').replace(/"/g, '""')}"`,
            `"${(l.users?.name || '').replace(/"/g, '""')}"`,
            `"${(l.users?.email || '').replace(/"/g, '""')}"`,
            `"${(l.inventory?.name || '').replace(/"/g, '""')}"`,
            `"${(l.description || '').replace(/"/g, '""')}"`
        ]);

        const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `cicr_audit_ledger_7days_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        ToastManager.show('Report Exported', `Downloaded 7-day audit ledger (${this.auditLogs.length} events).`, 'success');
    }

    static async triggerAuditRetentionCleanup() {
        const token = localStorage.getItem('cicr_token');
        if (!token) return;

        try {
            const res = await fetch(`${API_BASE}/audit/cleanup`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const json = await res.json();
            if (res.ok) {
                ToastManager.show('Retention Enforced', '7-Day backend retention sync complete. Expired records pruned.', 'success');
                await this.loadAuditLogs();
            } else {
                ToastManager.show('Cleanup Failed', json.message || 'Could not enforce retention.', 'error');
            }
        } catch (err: any) {
            ToastManager.show('Network Error', 'Failed to reach retention cleanup endpoint.', 'error');
        }
    }

    static formatTimeAgo(dateStr: string): string {
        const d = new Date(dateStr).getTime();
        if (isNaN(d)) return 'Recently';
        const diff = Math.floor((Date.now() - d) / 1000);
        if (diff < 30) return 'JUST NOW';
        if (diff < 60) return `${diff}S AGO`;
        if (diff < 3600) return `${Math.floor(diff / 60)}M AGO`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}H AGO`;
        return `${Math.floor(diff / 86400)}D AGO`;
    }

    static escapeHtml(str: string): string {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}


// ==========================================
// Terminal Simulator Logic
// ==========================================
class TerminalSimulator {
    static start() {
        const body = document.getElementById('terminal-log-body');
        if (!body) return;
        body.innerHTML = '';

        const lines = [
            { text: "Initializing CICR Core OS v3.5...", color: "#f3f4f6" },
            { text: "Establishing telemetry link to local JIIT-128 robotics vault...", color: "#f3f4f6" },
            { text: "Robotics telemetry buffers initialized successfully [OK]", color: "#39ff14" },
            { text: "Connecting to Qdrant vector database: Index hardware_kb loaded", color: "#00f0ff" },
            { text: "Seeding RAG knowledge base (STM32 manuals + pinouts)...", color: "#f3f4f6" },
            { text: "LangGraph workflow network compiled: 8 agent nodes ready", color: "#f3f4f6" },
            { text: "Vision Node: YOLOv11 component classification weights checked", color: "#ff007a" },
            { text: "Vision Node: SAM2 segmented coordinate maps ready", color: "#bd00ff" },
            { text: "MCP Server: Exposing tools: checkout_item, query_stock", color: "#ffd700" }
        ];

        let lineIdx = 0;

        function appendNextLine() {
            if (lineIdx >= lines.length) return;

            const line = lines[lineIdx];
            const lineEl = document.createElement('div');
            lineEl.className = 'terminal-line';
            body!.appendChild(lineEl);
            body!.scrollTop = body!.scrollHeight;

            let charIdx = 0;
            lineEl.innerHTML = `<span style="color: ${line.color}">&rarr;&nbsp;&rarr;&nbsp;</span><span class="txt-content" style="color: ${line.color}"></span>`;
            const txtSpan = lineEl.querySelector('.txt-content') as HTMLElement;

            lineEl.classList.add('visible');

            const cursorSpan = document.createElement('span');
            cursorSpan.className = 'cursor';
            lineEl.appendChild(cursorSpan);

            function typeChar() {
                if (charIdx < line.text.length) {
                    txtSpan.textContent += line.text[charIdx];
                    charIdx++;
                    setTimeout(typeChar, 25);
                } else {
                    cursorSpan.remove();

                    if (lineIdx === lines.length - 1) {
                        const finalCursor = document.createElement('span');
                        finalCursor.className = 'cursor';
                        lineEl.appendChild(finalCursor);

                        // Always keep typing: clear terminal logs and restart after 4 seconds!
                        setTimeout(() => {
                            body!.innerHTML = '';
                            lineIdx = 0;
                            appendNextLine();
                        }, 4000);
                    } else {
                        lineIdx++;
                        setTimeout(appendNextLine, 350);
                    }
                }
            }
            typeChar();
        }

        appendNextLine();
    }
}



// ==========================================
// Cherry Blossom (Sakura) Falling Leaves Engine
// ==========================================
interface SakuraPetal {
    x: number;
    y: number;
    size: number;
    speedY: number;
    swayFreq: number;
    swayAmp: number;
    swayPhase: number;
    rotation: number;
    rotationSpeed: number;
    flipAngle: number;
    flipSpeed: number;
    opacity: number;
    colorStart: string;
    colorEnd: string;
}

class SakuraAnimation {
    private canvas: HTMLCanvasElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private petals: SakuraPetal[] = [];
    private animationFrameId: number | null = null;
    private isRunning = false;
    private width = window.innerWidth;
    private height = window.innerHeight;

    private colors = [
        { start: '#ffd1e8', end: '#ec4899' },
        { start: '#fce7f3', end: '#f43f5e' },
        { start: '#fbcfe8', end: '#fda4af' },
        { start: '#f472b6', end: '#db2777' },
    ];

    constructor() {
        this.canvas = document.getElementById('sakura-canvas') as HTMLCanvasElement;
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        this.initPetals(75);
        this.setupEvents();
    }

    private resize() {
        if (!this.canvas) return;
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
    }

    private initPetals(count: number) {
        this.petals = [];
        for (let i = 0; i < count; i++) {
            this.petals.push(this.createPetal(true));
        }
    }

    private createPetal(randomY = false): SakuraPetal {
        const colorPair = this.colors[Math.floor(Math.random() * this.colors.length)];
        return {
            x: Math.random() * this.width,
            y: randomY ? Math.random() * this.height : -20 - Math.random() * 40,
            size: Math.random() * 9 + 8,
            speedY: Math.random() * 1.2 + 0.8,
            swayFreq: Math.random() * 0.02 + 0.01,
            swayAmp: Math.random() * 2.5 + 1.2,
            swayPhase: Math.random() * Math.PI * 2,
            rotation: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.03,
            flipAngle: Math.random() * Math.PI,
            flipSpeed: Math.random() * 0.03 + 0.01,
            opacity: Math.random() * 0.35 + 0.6,
            colorStart: colorPair.start,
            colorEnd: colorPair.end,
        };
    }

    private setupEvents() {
        window.addEventListener('resize', () => this.resize());
    }

    public start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.loop();
    }

    public stop() {
        this.isRunning = false;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    private drawPetal(petal: SakuraPetal) {
        if (!this.ctx) return;
        const { x, y, size, rotation, flipAngle, opacity, colorStart, colorEnd } = petal;

        this.ctx.save();
        this.ctx.translate(x, y);
        this.ctx.rotate(rotation);

        const scaleX = Math.cos(flipAngle);
        this.ctx.scale(scaleX, 1);

        this.ctx.globalAlpha = opacity;

        const grad = this.ctx.createLinearGradient(0, -size, 0, size);
        grad.addColorStop(0, colorStart);
        grad.addColorStop(1, colorEnd);
        this.ctx.fillStyle = grad;

        this.ctx.beginPath();
        this.ctx.moveTo(0, -size);
        this.ctx.bezierCurveTo(size * 0.75, -size * 0.75, size * 0.9, size * 0.4, 0, size);
        this.ctx.bezierCurveTo(-size * 0.9, size * 0.4, -size * 0.75, -size * 0.75, 0, -size);
        this.ctx.closePath();
        this.ctx.fill();

        this.ctx.strokeStyle = 'rgba(236, 72, 153, 0.25)';
        this.ctx.lineWidth = 0.8;
        this.ctx.stroke();

        this.ctx.restore();
    }

    private loop() {
        if (!this.isRunning || !this.ctx || !this.canvas) return;

        this.ctx.clearRect(0, 0, this.width, this.height);

        for (let i = 0; i < this.petals.length; i++) {
            const p = this.petals[i];

            p.y += p.speedY;
            p.swayPhase += p.swayFreq;
            p.x += Math.sin(p.swayPhase) * p.swayAmp;
            p.rotation += p.rotationSpeed;
            p.flipAngle += p.flipSpeed;

            if (p.y > this.height + 30 || p.x < -40 || p.x > this.width + 40) {
                this.petals[i] = this.createPetal(false);
            }

            this.drawPetal(p);
        }

        this.animationFrameId = requestAnimationFrame(() => this.loop());
    }
}

// Extend global window interface for development debugging & admin actions
declare global {
    interface Window {
        bg3D?: Background3D;
        dashboard?: DashboardManager;
        adminApprove?: (id: string) => void;
        adminReject?: (id: string) => void;
        adminSetRole?: (id: string, role: 'ADMIN' | 'MEMBER') => void;
        adminDeleteUser?: (id: string, name: string) => void;
        adminDeleteItem?: (id: string, name: string) => void;
        adminApproveHardware?: (id: string) => void;
        adminRejectHardware?: (id: string) => void;
        openAuditDetail?: (id: string) => void;
        openBulkReturnModal?: () => void;
        openPasswordResetModal?: () => void;
    }
}

// ==========================================
// Team Showcase Manager (GDG JIIT Style Interactive Showcase)
// ==========================================
interface TeamMember {
    id: string;
    name: string;
    role: string;
    greeting?: string;
    avatar: string;
    avatarPos: string;
    accentColor: string;
    firstNameColor?: string;
    lastNameColor?: string;
    socials: {
        platform: 'linkedin' | 'github';
        label: string;
        url: string;
    }[];
}

class TeamShowcaseManager {
    private static activeCategory: 'mentors' | 'team' = 'team';
    private static activeIndex: number = 0;
    private static isInitialized: boolean = false;

    private static readonly MENTORS: TeamMember[] = [
        {
            id: 'gunjan',
            name: 'Gunjan Pal',
            role: 'Core Team',
            greeting: 'Hi, my name is',
            avatar: '/devs/gunjan.jpg',
            avatarPos: 'center 20%',
            accentColor: '#bd00ff',
            firstNameColor: '#bd00ff',
            lastNameColor: '#ff007a',
            socials: [
                { platform: 'linkedin', label: 'Gunjan Pal', url: 'https://www.linkedin.com/in/gunjan-pal-796093284/' },
                { platform: 'github', label: 'Gunjan00001', url: 'https://github.com/Gunjan00001' }
            ]
        }
    ];

    private static readonly TEAM: TeamMember[] = [
        {
            id: 'vardaan',
            name: 'Vardaan Saxena',
            role: 'Frontend + Integration',
            greeting: 'Hi, my name is',
            avatar: '/devs/vardaan.jpg',
            avatarPos: 'center 24%',
            accentColor: '#00f0ff',
            firstNameColor: '#ff3366',
            lastNameColor: '#00f0ff',
            socials: [
                { platform: 'linkedin', label: 'Vardaan Saxena', url: 'https://www.linkedin.com/in/vardaan-saxena-b4b4a4365/' },
                { platform: 'github', label: 'simplyvardaan', url: 'https://github.com/simplyvardaan/' }
            ]
        },
        {
            id: 'kushagra',
            name: 'Kushagra Garg',
            role: 'Backend',
            greeting: 'Hi, my name is',
            avatar: '/devs/kushagra.png',
            avatarPos: 'center 8%',
            accentColor: '#00ff88',
            firstNameColor: '#00ff88',
            lastNameColor: '#00f0ff',
            socials: [
                { platform: 'linkedin', label: 'Kushagra Garg', url: 'https://www.linkedin.com/in/kushagra-garg-10bab5377/' },
                { platform: 'github', label: 'Sun-fire-nikka', url: 'https://github.com/Sun-fire-nikka' }
            ]
        },
        {
            id: 'mahak',
            name: 'Mahak Katahara',
            role: 'Contributor',
            greeting: 'Hi, my name is',
            avatar: '/devs/mahak.png',
            avatarPos: 'center 18%',
            accentColor: '#ff007a',
            firstNameColor: '#ff007a',
            lastNameColor: '#bd00ff',
            socials: [
                { platform: 'linkedin', label: 'Mahak Katahara', url: 'https://www.linkedin.com/in/mahak-katahara-947122389/' },
                { platform: 'github', label: 'mahakkatahara', url: 'https://github.com/mahakkatahara' }
            ]
        },
        {
            id: 'divyam',
            name: 'Divyam Jain',
            role: 'Beta Tester',
            greeting: 'Hi, my name is',
            avatar: '/devs/divyam.png',
            avatarPos: 'center 15%',
            accentColor: '#ffb703',
            firstNameColor: '#ffb703',
            lastNameColor: '#00f0ff',
            socials: [
                { platform: 'linkedin', label: 'Divyam Jain', url: 'https://www.linkedin.com/in/divyamjain8108' },
                { platform: 'github', label: 'DJByteForge', url: 'https://github.com/DJByteForge' }
            ]
        }
    ];

    public static init() {
        this.bindEvents();
        this.renderCategory(this.activeCategory);
    }

    private static getCurrentList(): TeamMember[] {
        return this.activeCategory === 'mentors' ? this.MENTORS : this.TEAM;
    }

    public static setCategory(category: 'mentors' | 'team') {
        this.activeCategory = category;
        this.activeIndex = 0;
        this.renderCategory(category);
    }

    public static selectMember(index: number) {
        const list = this.getCurrentList();
        if (index < 0) index = list.length - 1;
        if (index >= list.length) index = 0;
        this.activeIndex = index;
        this.renderHeroCard(list[this.activeIndex]);
        this.updateCarouselActiveState();
    }

    public static nextMember() {
        this.selectMember(this.activeIndex + 1);
    }

    public static prevMember() {
        this.selectMember(this.activeIndex - 1);
    }

    private static renderCategory(category: 'mentors' | 'team') {
        // Update tab button active states
        const tabMentors = document.getElementById('team-tab-mentors');
        const tabTeam = document.getElementById('team-tab-team');
        if (tabMentors) tabMentors.classList.toggle('active', category === 'mentors');
        if (tabTeam) tabTeam.classList.toggle('active', category === 'team');

        const tabMentorsCount = document.querySelector('#team-tab-mentors .category-count');
        if (tabMentorsCount) tabMentorsCount.textContent = String(this.MENTORS.length);
        const tabTeamCount = document.querySelector('#team-tab-team .category-count');
        if (tabTeamCount) tabTeamCount.textContent = String(this.TEAM.length);

        const list = this.getCurrentList();
        if (this.activeIndex >= list.length) this.activeIndex = 0;

        // Render carousel track avatars
        const track = document.getElementById('team-carousel-track');
        if (track) {
            track.innerHTML = list.map((m, idx) => `
                <button type="button" class="team-avatar-selector ${idx === this.activeIndex ? 'active' : ''}" data-index="${idx}" aria-label="View profile of ${m.name}">
                    <div class="selector-avatar-circle" style="--accent: ${m.accentColor};">
                        <img src="${m.avatar}" alt="${m.name}" class="selector-avatar-img" style="object-position: ${m.avatarPos};" loading="lazy">
                    </div>
                    <span class="selector-avatar-name">${m.name.split(' ')[0]}</span>
                </button>
            `).join('');

            // Add click listeners to avatar items
            track.querySelectorAll('.team-avatar-selector').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.getAttribute('data-index') || '0', 10);
                    this.selectMember(idx);
                });
            });
        }

        // Render Hero Card for current active member
        this.renderHeroCard(list[this.activeIndex]);
    }

    private static renderHeroCard(m: TeamMember) {
        const card = document.getElementById('team-hero-card');
        const avatarImg = document.getElementById('hero-avatar-img') as HTMLImageElement;
        const rolePill = document.getElementById('hero-role-pill');
        const displayName = document.getElementById('hero-display-name');
        const socialLinks = document.getElementById('hero-social-links');
        const ambientGlow = document.getElementById('hero-ambient-glow');
        const glowRing = document.getElementById('hero-avatar-glow-ring');

        if (!m) return;

        // Split name for GDG JIIT style dual-color headline
        const nameParts = m.name.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        // Trigger subtle animation
        if (card) {
            card.classList.remove('hero-fade-active');
            void card.offsetWidth; // Force reflow
            card.classList.add('hero-fade-active');
            card.style.setProperty('--card-accent', m.accentColor);
        }

        if (avatarImg) {
            avatarImg.src = m.avatar;
            avatarImg.alt = m.name;
            avatarImg.style.objectPosition = m.avatarPos;
        }

        if (rolePill) {
            rolePill.textContent = m.role;
            rolePill.style.color = m.accentColor;
            rolePill.style.borderColor = `${m.accentColor}66`;
            rolePill.style.boxShadow = `0 0 14px ${m.accentColor}33`;
        }

        if (displayName) {
            displayName.style.setProperty('--first-name-color', m.firstNameColor || m.accentColor);
            displayName.style.setProperty('--last-name-color', m.lastNameColor || m.accentColor);
            displayName.innerHTML = `
                <span class="hero-first-name">${firstName}</span>
                <span class="hero-last-name">${lastName}</span>
            `;
        }

        if (ambientGlow) {
            ambientGlow.style.background = m.accentColor;
        }

        if (glowRing) {
            glowRing.style.background = `conic-gradient(from 180deg, ${m.accentColor}, #bd00ff, #ff007a, ${m.accentColor})`;
            glowRing.style.boxShadow = `0 0 38px ${m.accentColor}66, 0 0 16px rgba(189, 0, 255, 0.3)`;
        }

        const getSocialIconSvg = (platform: 'linkedin' | 'github') => {
            if (platform === 'github') {
                return `<svg class="social-icon-svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`;
            }
            if (platform === 'linkedin') {
                return `<svg class="social-icon-svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>`;
            }
            return '';
        };

        if (socialLinks) {
            socialLinks.innerHTML = m.socials.map(s => `
                <a href="${s.url}" target="_blank" rel="noopener noreferrer" class="hero-social-pill" title="${m.name} on ${s.platform === 'github' ? 'GitHub' : 'LinkedIn'}">
                    ${getSocialIconSvg(s.platform)}
                    <span>${s.label}</span>
                </a>
            `).join('');
        }

        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            lucide.createIcons();
        }
    }

    private static updateCarouselActiveState() {
        const track = document.getElementById('team-carousel-track');
        if (!track) return;

        const items = track.querySelectorAll('.team-avatar-selector');
        items.forEach((item, idx) => {
            const isActive = idx === this.activeIndex;
            item.classList.toggle('active', isActive);
        });
    }

    private static bindEvents() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const tabMentors = document.getElementById('team-tab-mentors');
        const tabTeam = document.getElementById('team-tab-team');
        const btnPrev = document.getElementById('team-carousel-prev');
        const btnNext = document.getElementById('team-carousel-next');

        if (tabMentors) {
            tabMentors.addEventListener('click', () => this.setCategory('mentors'));
        }

        if (tabTeam) {
            tabTeam.addEventListener('click', () => this.setCategory('team'));
        }

        if (btnPrev) {
            btnPrev.addEventListener('click', () => this.prevMember());
        }

        if (btnNext) {
            btnNext.addEventListener('click', () => this.nextMember());
        }

        // Keyboard navigation support when viewing developers section
        document.addEventListener('keydown', (e) => {
            const devSection = document.getElementById('developers-view');
            if (!devSection || devSection.style.display === 'none') return;
            if (e.key === 'ArrowLeft') {
                this.prevMember();
            } else if (e.key === 'ArrowRight') {
                this.nextMember();
            }
        });
    }
}

(window as any).TeamShowcaseManager = TeamShowcaseManager;

// ==========================================
// Theme Manager System
// ==========================================
class ThemeManager {
    private static themeSelectEl: HTMLSelectElement | null = null;
    private static navThemeSelectEl: HTMLSelectElement | null = null;
    private static headerThemeSelectEl: HTMLSelectElement | null = null;
    private static sakuraAnim: SakuraAnimation | null = null;

    public static init() {
        this.sakuraAnim = new SakuraAnimation();

        this.themeSelectEl = document.getElementById('theme-select') as HTMLSelectElement;
        this.navThemeSelectEl = document.getElementById('nav-theme-select') as HTMLSelectElement;
        this.headerThemeSelectEl = document.getElementById('header-theme-select') as HTMLSelectElement;

        const defaultTheme = localStorage.getItem('cicr_vault_theme') || 'cyberpunk';
        this.applyTheme(defaultTheme);

        if (this.themeSelectEl) {
            this.themeSelectEl.value = defaultTheme;
            this.themeSelectEl.addEventListener('change', (e) => {
                const val = (e.target as HTMLSelectElement).value;
                this.applyTheme(val);
            });
        }

        if (this.navThemeSelectEl) {
            this.navThemeSelectEl.value = defaultTheme;
            this.navThemeSelectEl.addEventListener('change', (e) => {
                const val = (e.target as HTMLSelectElement).value;
                this.applyTheme(val);
            });
        }

        if (this.headerThemeSelectEl) {
            this.headerThemeSelectEl.value = defaultTheme;
            this.headerThemeSelectEl.addEventListener('change', (e) => {
                const val = (e.target as HTMLSelectElement).value;
                this.applyTheme(val);
            });
        }

        const themeBtnDark = document.getElementById('theme-btn-dark');
        const themeBtnLight = document.getElementById('theme-btn-light');
        const themeBtnPink = document.getElementById('theme-btn-pink');

        if (themeBtnDark) {
            themeBtnDark.addEventListener('click', () => {
                this.applyTheme('cyberpunk');
            });
        }
        if (themeBtnLight) {
            themeBtnLight.addEventListener('click', () => {
                this.applyTheme('light');
            });
        }
        if (themeBtnPink) {
            themeBtnPink.addEventListener('click', () => {
                this.applyTheme('sakura');
            });
        }
    }

    public static applyTheme(theme: string) {
        if (theme === 'matrix' || theme === 'midnight' || theme === 'avengers') {
            theme = 'cyberpunk';
        }
        document.documentElement.setAttribute('data-theme', theme);
        document.body.classList.remove(
            'theme-cyberpunk',
            'theme-light',
            'theme-pink',
            'theme-sakura'
        );
        document.body.classList.add(`theme-${theme}`);
        if (theme === 'pink' || theme === 'sakura') {
            document.body.classList.add('theme-sakura');
            document.body.classList.add('theme-pink');
        }
        localStorage.setItem('cicr_vault_theme', theme);
        localStorage.setItem('cicr_theme', theme === 'sakura' ? 'pink' : theme === 'cyberpunk' ? 'dark' : theme);

        if (this.themeSelectEl && this.themeSelectEl.value !== theme) {
            this.themeSelectEl.value = theme;
        }
        if (this.navThemeSelectEl && this.navThemeSelectEl.value !== theme) {
            this.navThemeSelectEl.value = theme;
        }
        if (this.headerThemeSelectEl && this.headerThemeSelectEl.value !== theme) {
            this.headerThemeSelectEl.value = theme;
        }

        // Sync sidebar theme buttons if present
        const themeBtnDark = document.getElementById('theme-btn-dark');
        const themeBtnLight = document.getElementById('theme-btn-light');
        const themeBtnPink = document.getElementById('theme-btn-pink');
        [themeBtnDark, themeBtnLight, themeBtnPink].forEach(b => b?.classList.remove('active'));
        if (theme === 'light') themeBtnLight?.classList.add('active');
        else if (theme === 'sakura' || theme === 'pink') themeBtnPink?.classList.add('active');
        else if (theme === 'cyberpunk') themeBtnDark?.classList.add('active');

        if (window.bg3D) {
            window.bg3D.updateThemeColors(theme);
        }

        if (theme === 'sakura' || theme === 'pink') {
            this.sakuraAnim?.start();
        } else {
            this.sakuraAnim?.stop();
        }
    }
}

// ==========================================
// 7. Application Bootstrap
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    window.bg3D = new Background3D();
    ThemeManager.init();
    DatabaseManager.init();
    ModalManager.init();
    PasswordResetManager.init();
    TeamShowcaseManager.init();

    AuthManager.init();
    AdminManager.init();
    AdminManager.loadHardwareRequests(true);
    DatabaseManager.updateNotificationBadges();
    DatabaseManager.startAutoSync(3000);
    lucide.createIcons();

    // Global mouse-coordinate spotlight tracker for interactive cyber gridlines
    document.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth) * 100;
        const y = (e.clientY / window.innerHeight) * 100;
        document.documentElement.style.setProperty('--mouse-x', `${x}%`);
        document.documentElement.style.setProperty('--mouse-y', `${y}%`);
    });

    // Custom 3D tilt interaction logic for desktop interactivity
    const apply3DTilt = (el: HTMLElement, maxRotation: number = 6) => {
        el.addEventListener('mousemove', (e) => {
            if (window.innerWidth < 768) return; // Only apply on desktop
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const rotateX = ((y - centerY) / centerY) * -maxRotation;
            const rotateY = ((x - centerX) / centerX) * maxRotation;

            el.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) scale3d(1.01, 1.01, 1.01)`;
            el.style.transition = 'transform 0.1s ease-out';
        });

        el.addEventListener('mouseleave', () => {
            el.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
            el.style.transition = 'transform 0.5s ease';
        });
    };

    const heroCard = document.getElementById('team-hero-card');
    if (heroCard) {
        apply3DTilt(heroCard, 5);
    }





    // IntersectionObserver scroll reveal triggers matching Pinterest visual transition
    const revealElements = document.querySelectorAll('.reveal');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, {
        threshold: 0.08,
        rootMargin: '0px 0px -60px 0px'
    });
    revealElements.forEach(el => observer.observe(el));


});
