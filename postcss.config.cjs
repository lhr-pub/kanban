const purgecss = require('@fullhuman/postcss-purgecss');

module.exports = {
    plugins: [
        require('postcss-import'),
        purgecss({
            content: [
                './public/**/*.html',
                './public/**/*.js',
                './server.js'
            ],
            defaultExtractor: content => content.match(/[A-Za-z0-9-_:\/]+/g) || [],
            safelist: {
                standard: [
                    // dynamic classnames and stateful classes
                    'hidden', 'page', 'container', 'header', 'header-actions', 'online-users', 'user-badge',
                    'list', 'list-header', 'list-title', 'cards', 'card', 'card-title', 'card-labels', 'label',
                    'label-red', 'label-green', 'label-blue', 'label-yellow', 'label-purple', 'card-badges',
                    'badge', 'badge-icon', 'badge-user', 'card-quick', 'card-assignee', 'card-deadline',
                    'card-center-actions', 'archive-column', 'archive-container', 'archive-page',
                    'clickable', 'dragging', 'dragging-cards', 'visually-hidden'
                ],
                deep: [
                    /column.*/, /list.*/, /card.*/, /badge.*/, /label.*/, /header.*/, /archive.*/,
                    /btn.*/, /modal.*/, /drawer.*/, /composer.*/
                ],
                greedy: [
                    /data-status=.*/, /aria-.*/
                ]
            }
        }),
        require('autoprefixer'),
        process.env.MINIFY === 'true' ? require('cssnano')({ preset: 'default' }) : null
    ].filter(Boolean)
};