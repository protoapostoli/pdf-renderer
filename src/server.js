import express from 'express';
import { chromium } from 'playwright';

const app = express();

const PORT = process.env.PORT || 3000;
const RENDERER_TOKEN = process.env.RENDERER_TOKEN;

app.use(express.json({
    limit: '10mb'
}));

let browser = null;


/**
 * Get a shared Chromium browser.
 *
 * We keep Chromium running between requests rather than
 * launching a new browser process for every PDF.
 */
async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log('Launching Chromium...');

        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        console.log('Chromium ready.');
    }

    return browser;
}


/**
 * Simple authentication middleware.
 *
 * The renderer will eventually only be reachable over
 * Railway's private network, but we still protect the
 * endpoint with a shared secret.
 */
function authenticate(req, res, next) {
    if (!RENDERER_TOKEN) {
        return res.status(500).json({
            error: 'RENDERER_TOKEN is not configured'
        });
    }

    const authorization = req.headers.authorization || '';

    if (authorization !== `Bearer ${RENDERER_TOKEN}`) {
        return res.status(401).json({
            error: 'Unauthorized'
        });
    }

    next();
}


/**
 * Health check.
 *
 * Railway can use this to determine whether the service
 * is alive.
 */
app.get('/health', async (req, res) => {
    res.json({
        status: 'ok',
        browser: browser?.isConnected() ? 'connected' : 'not_started'
    });
});


/**
 * Version / service information.
 */
app.get('/version', (req, res) => {
    res.json({
        service: 'pdf-renderer',
        version: '1.0.0'
    });
});


/**
 * Render HTML into a PDF.
 */
app.post('/render', authenticate, async (req, res) => {
    const {
        html,
        options = {}
    } = req.body;

    if (!html || typeof html !== 'string') {
        return res.status(400).json({
            error: 'The "html" field is required.'
        });
    }

    let context = null;
    let page = null;

    try {
        const chromiumBrowser = await getBrowser();

        /*
         * Create a fresh browser context for every request.
         *
         * This prevents cookies, local storage, etc. from
         * leaking between different certificate generations.
         */
        context = await chromiumBrowser.newContext();

        page = await context.newPage();

        /*
         * Set the HTML directly.
         */
        await page.setContent(html, {
            waitUntil: 'networkidle'
        });

        /*
         * Give fonts/images a moment to finish rendering.
         */
        await page.evaluate(async () => {
            if (document.fonts) {
                await document.fonts.ready;
            }
        });

        /*
         * Generate the PDF.
         */
        const pdf = await page.pdf({
            format: options.format || 'Letter',

            landscape: options.landscape || false,

            printBackground:
                options.printBackground !== undefined
                    ? options.printBackground
                    : true,

            margin: {
                top: options.margin?.top || '0',
                right: options.margin?.right || '0',
                bottom: options.margin?.bottom || '0',
                left: options.margin?.left || '0'
            },

            preferCSSPageSize:
                options.preferCSSPageSize !== undefined
                    ? options.preferCSSPageSize
                    : true
        });

        res.setHeader('Content-Type', 'application/pdf');

        res.setHeader(
            'Content-Disposition',
            'inline; filename="document.pdf"'
        );

        res.send(pdf);

    } catch (error) {
        console.error('PDF rendering failed:', error);

        res.status(500).json({
            error: 'PDF rendering failed.',
            message: error.message
        });

    } finally {
        /*
         * Close the page/context, but NOT Chromium itself.
         *
         * Chromium stays alive so subsequent certificates
         * don't have to pay the browser startup cost.
         */
        try {
            if (page) {
                await page.close();
            }
        } catch (error) {
            console.error('Error closing page:', error);
        }

        try {
            if (context) {
                await context.close();
            }
        } catch (error) {
            console.error('Error closing browser context:', error);
        }
    }
});


/**
 * Graceful shutdown.
 */
async function shutdown() {
    console.log('Shutting down PDF renderer...');

    if (browser) {
        await browser.close();
    }

    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);


/**
 * Start server.
 */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`PDF renderer listening on port ${PORT}`);
});
