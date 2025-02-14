/*global $STM_Config*/
import React from 'react';
import PropTypes from 'prop-types';
import reactForm from 'app/utils/ReactForm';
import _ from 'lodash';
import { connect } from 'react-redux';
import classnames from 'classnames';
import Tooltip from 'react-tooltip-lite';
import * as transactionActions from 'app/redux/TransactionReducer';
import * as userActions from 'app/redux/UserReducer';
import MarkdownViewer from 'app/components/cards/MarkdownViewer';
import TagInput, { validateTagInput } from 'app/components/cards/TagInput';
import { extractRtags } from 'app/utils/ExtractContent';
import LoadingIndicator from 'app/components/elements/LoadingIndicator';
import PostCategoryBanner from 'app/components/elements/PostCategoryBanner';
import sanitizeConfig, { allowedTags } from 'app/utils/SanitizeConfig';
import sanitize from 'sanitize-html';
import HtmlReady from 'shared/HtmlReady';
import { fromJS, Map, OrderedSet } from 'immutable';
import { Remarkable } from 'remarkable';
import Dropzone from 'react-dropzone';
import tt from 'counterpart';
import { loadUserTemplates, saveUserTemplates } from 'app/utils/UserTemplates';
import BadActorList from 'app/utils/BadActorList';
import { FormattedHTMLMessage } from 'app/Translator';
import { api } from "@hiveio/hive-js";
import HumanizeDuration from "humanize-duration";
import VisualEditor from './VisualEditor';
import { calculateRcStats } from "../../utils/UserUtil";

const remarkable = new Remarkable({ html: true, breaks: true });

const RTE_DEFAULT = false;
const MAX_TAGS = 8;
const MAX_FILE_TO_UPLOAD = 10;
const imagesToUpload = [];

function allTags(userInput, originalCategory, hashtags) {
    // take space-delimited user input
    let tags = OrderedSet(userInput ? userInput.trim().replace(/#/g, '').split(/ +/) : []);

    // remove original cat, if present
    if (originalCategory && /^[-a-z\d]+$/.test(originalCategory)) tags = tags.delete(originalCategory);

    // append hashtags from post until limit is reached
    const tagged = [...hashtags];
    while (tags.size < MAX_TAGS && tagged.length > 0) {
        tags = tags.add(tagged.shift());
    }

    return tags;
}

class ReplyEditor extends React.Component {
    static propTypes = {
        // html component attributes
        formId: PropTypes.string.isRequired, // unique form id for each editor
        type: PropTypes.oneOf(['submit_story', 'submit_comment', 'edit']),
        successCallback: PropTypes.func, // indicator that the editor is done and can be hidden
        onCancel: PropTypes.func, // hide editor when cancel button clicked

        author: PropTypes.string, // empty or string for top-level post
        permlink: PropTypes.string, // new or existing category (default calculated from title)
        parent_author: PropTypes.string, // empty or string for top-level post
        parent_permlink: PropTypes.string, // new or existing category
        jsonMetadata: PropTypes.object, // An existing comment has its own meta data
        category: PropTypes.string, // initial value
        title: PropTypes.string, // initial value
        summary: PropTypes.string,
        altAuthor: PropTypes.string,
        body: PropTypes.string, // initial value
        defaultPayoutType: PropTypes.string,
        payoutType: PropTypes.string,
        postTemplateName: PropTypes.string,
        maxAcceptedPayout: PropTypes.number,
        isStory: PropTypes.bool,
    };

    static defaultProps = {
        isStory: false,
        author: '',
        parent_author: '',
        parent_permlink: '',
        type: 'submit_comment',
        maxAcceptedPayout: null,
    };

    constructor(props) {
        super();
        this.state = {
            initialized: false,
            progress: {},
            imagesUploadCount: 0,
            enableSideBySide: true,
            userRc: undefined,
        };
        this.initForm(props);
        this.textareaRef = React.createRef();
        this.titleRef = React.createRef();
        this.draftRef = React.createRef();
        this.dropzoneRef = React.createRef();
    }

    async getUserRc(username) {
        const res = await api.callAsync('rc_api.find_rc_accounts', { accounts: [username] });
        const rcAccounts = _.get(res, 'rc_accounts');

        if (rcAccounts) {
            this.setState({ userRc: rcAccounts[0] });
        }
    }

    componentDidUpdate() {
        const { formId } = this.props;

        // Only need to do it on first time to load drafts etc...
        // This also prevents infinite rerender due to the use of setState below
        if (this.state.initialized === true) {
            return;
        }

        if (process.env.BROWSER) {
            // Check for rte editor preference
            let rte = this.props.isStory && JSON.parse(localStorage.getItem('replyEditorData-rte') || RTE_DEFAULT);
            let raw = null;

            // Process initial body value (if this is an edit)
            const { body } = this.state;
            if (body.value) {
                raw = body.value;
            }

            // Check for draft data
            let draft = localStorage.getItem('replyEditorData-' + formId);
            if (draft) {
                draft = JSON.parse(draft);
                const {
                    tags, title, summary, altAuthor,
                } = this.state;

                if (tags) {
                    this.checkTagsCommunity(draft.tags);
                    tags.props.onChange(draft.tags);
                }

                if (title) title.props.onChange(draft.title);
                if (summary) summary.props.onChange(draft.summary);
                if (altAuthor) altAuthor.props.onChange(draft.altAuthor);
                if (draft.payoutType) this.props.setPayoutType(formId, draft.payoutType);
                if (draft.maxAcceptedPayout) this.props.setMaxAcceptedPayout(formId, draft.maxAcceptedPayout);
                if (draft.beneficiaries) this.props.setBeneficiaries(formId, draft.beneficiaries);
                raw = draft.body;
            }

            // If we have an initial body, check if it's html or markdown
            if (raw) {
                rte = isHtmlTest(raw);
            }

            // console.log("initial reply body:", raw || '(empty)')
            body.props.onChange(raw);
            // eslint-disable-next-line react/no-did-update-set-state
            this.setState({
                rte,
                rte_value: rte ? stateFromHtml(raw) : null,
            });
        }

        // Overwrite category (even if draft loaded) if authoritative category was provided
        if (this.props.category) {
            if (this.state.tags) {
                this.state.tags.props.onChange(this.props.initialValues.tags);
            }
            this.checkTagsCommunity(this.props.category);
        }

        // Verify and Set defaultBeneficiaries if enabled
        const qualifiedBeneficiaries = [];

        if (
            this.props.defaultBeneficiaries
            && this.props.defaultBeneficiaries.toArray().length > 0
            && this.props.referralSystem != 'disabled'
        ) {
            this.props.defaultBeneficiaries.toArray().forEach((element) => {
                const label = element.get('label');
                const name = element.get('name');
                const weight = parseInt(element.get('weight'));

                if (label && name && weight) {
                    if (
                        (label === 'referrer'
                            && weight <= $STM_Config.referral.max_fee_referrer
                            && !BadActorList.includes(name))
                        || (label === 'creator'
                            && weight <= $STM_Config.referral.max_fee_creator
                            && !BadActorList.includes(name))
                        || (label === 'provider'
                            && weight <= $STM_Config.referral.max_fee_provider
                            && !BadActorList.includes(name))
                    ) {
                        if (qualifiedBeneficiaries.find((beneficiary) => beneficiary.username === name)) {
                            qualifiedBeneficiaries.find(
                                (beneficiary) => beneficiary.username === name
                            ).percent += parseInt((weight / 100).toFixed(0));
                        } else {
                            qualifiedBeneficiaries.push({
                                username: name,
                                percent: parseInt((weight / 100).toFixed(0)),
                            });
                        }
                    }
                }
            });
        }

        if (qualifiedBeneficiaries.length > 0) {
            this.props.setBeneficiaries(formId, qualifiedBeneficiaries);
        }

        this.state.initialized = true;
    }

    componentDidMount() {
        const { username } = this.props;
        this.getUserRc(username);

        setTimeout(() => {
            // if (this.refs.rte) this.refs.rte._focus();
            if (this.props.isStory) this.titleRef.current.focus();
            else if (this.textareaRef.current) this.textareaRef.current.focus();
        }, 300);
    }

    // shouldComponentUpdate = shouldComponentUpdate(this, 'ReplyEditor');

    // getSnapshotBeforeUpdate() is invoked right before the most recently rendered output is committed to e.g. the DOM.
    // It enables your component to capture some information from the DOM (e.g. scroll position)
    // before it is potentially changed. Any value returned by this lifecycle method will be passed
    // as a parameter to componentDidUpdate().
    getSnapshotBeforeUpdate(prevProps, prevState) {
        if (process.env.BROWSER) {
            const ts = prevState;
            const ns = this.state;
            const tp = prevState;
            const np = this.props;

            if (typeof np.postTemplateName !== 'undefined' && np.postTemplateName !== null) {
                const { formId } = tp;

                if (np.postTemplateName.indexOf('create_') === 0) {
                    const { username } = this.props;
                    const {
                        body, title, summary, altAuthor, tags
                    } = ns;
                    const { payoutType, beneficiaries } = np;
                    const userTemplates = loadUserTemplates(username);
                    const newTemplateName = np.postTemplateName.replace('create_', '');
                    const newTemplate = {
                        name: np.postTemplateName.replace('create_', ''),
                        beneficiaries,
                        payoutType,
                        markdown: body !== undefined ? body.value : '',
                        title: title !== undefined ? title.value : '',
                        summary: summary !== undefined ? summary.value : '',
                        altAuthor: altAuthor !== undefined ? altAuthor.value : '',
                        tags: tags !== undefined ? tags.value : '',
                    };

                    let updated = false;
                    for (let ui = 0; ui < userTemplates.length; ui += 1) {
                        if (userTemplates[ui].name === newTemplateName) {
                            userTemplates[ui] = newTemplate;
                            updated = true;
                        }
                    }

                    if (updated === false) {
                        userTemplates.push(newTemplate);
                    }

                    saveUserTemplates(username, userTemplates);

                    this.props.setPostTemplateName(formId, null);
                } else {
                    const userTemplates = loadUserTemplates(np.username);

                    for (let ti = 0; ti < userTemplates.length; ti += 1) {
                        const template = userTemplates[ti];
                        if (template.name === np.postTemplateName) {
                            this.state.body.props.onChange(template.markdown);
                            this.state.title.props.onChange(template.title);
                            this.state.summary.props.onChange(template.summary);
                            this.state.altAuthor.props.onChange(template.altAuthor);
                            this.state.tags.props.onChange(template.tags);
                            this.props.setPayoutType(formId, template.payoutType);
                            this.props.setBeneficiaries(formId, template.beneficiaries);

                            this.props.setPostTemplateName(formId, null);
                            break;
                        }
                    }
                }
            }

            // Save current draft to localStorage
            if (
                ts.body.value !== ns.body.value
                || (ns.tags && ts.tags.value !== ns.tags.value)
                || (ns.title && ts.title.value !== ns.title.value)
                || (ns.summary && ts.summary.value !== ns.summary.value)
                || (ns.altAuthor && ts.altAuthor.value !== ns.altAuthor.value)
                || np.payoutType !== tp.payoutType
                || np.beneficiaries !== tp.beneficiaries
                || np.maxAcceptedPayout !== tp.maxAcceptedPayout
            ) {
                // also prevents saving after parent deletes this information
                const {
                    formId, payoutType, beneficiaries, maxAcceptedPayout
                } = np;
                const {
                    tags, title, summary, altAuthor, body
                } = ns;
                const data = {
                    formId,
                    title: title ? title.value : undefined,
                    tags: tags ? tags.value : undefined,
                    body: body.value,
                    summary: summary ? summary.value : undefined,
                    altAuthor: altAuthor ? altAuthor.value : undefined,
                    payoutType,
                    beneficiaries,
                    maxAcceptedPayout,
                };

                clearTimeout(saveEditorTimeout);
                saveEditorTimeout = setTimeout(() => {
                    // console.log('save formId', formId, body.value)
                    localStorage.setItem('replyEditorData-' + formId, JSON.stringify(data, null, 0));
                    this.showDraftSaved();
                }, 500);
            }

            if (ns.tags && ts.tags && ts.tags.value !== ns.tags.value) {
                this.checkTagsCommunity(ns.tags.value);
            }
        }

        return null;
    }

    checkTagsCommunity(tagsInput) {
        let community = null;
        if (tagsInput) {
            const primary = tagsInput.split(' ')[0];
            if (primary.substring(0, 5) === 'hive-') {
                community = primary;
            }
        }
        this.setState({ community });
    }

    onPostDestinationChange = (category) => {
        const { tags } = this.state;
        const currentTags = tags.value.split(' ');

        if (/^hive-[0-9]*$/.test(category) && /^hive-[0-9]*$/.test(currentTags[0])) {
            currentTags[0] = category;
        } else {
            currentTags.unshift(category);
        }

        tags.props.onChange(currentTags.join(' '));
    };

    initForm(props) {
        const { isStory, type, fields } = props;
        const isEdit = type === 'edit';
        const maxKb = isStory ? 64 : 16;
        reactForm({
            fields,
            instance: this,
            name: 'replyForm',
            initialValues: props.initialValues,
            validation: (values) => {
                const markdownRegex = /(?:\*[\w\s]*\*|#[\w\s]*#|_[\w\s]*_|~[\w\s]*~|]\s*\(|]\s*\[)/;
                const htmlTagRegex = /<\/?[\w\s="/.':;#-/?]+>/gi;
                const altAuthorAllowedCharactersRegex = /^[\w.\d-]+$/;
                let bodyValidation = null;

                if (!values.body) {
                    bodyValidation = tt('g.required');
                }
                if (values.body && new Blob([values.body]).size >= maxKb * 1024 - 256) {
                    bodyValidation = `Post body exceeds ${maxKb * 1024 - 256} bytes.`;
                }

                return {
                    title:
                        isStory
                        && (!values.title || values.title.trim() === ''
                            ? tt('g.required')
                            : values.title.length > 255
                                ? tt('reply_editor.shorten_title')
                                : markdownRegex.test(values.title)
                                    ? tt('reply_editor.markdown_not_supported')
                                    : htmlTagRegex.test(values.title) ? tt('reply_editor.html_not_supported') : null),
                    tags: isStory && validateTagInput(values.tags, !isEdit),
                    body: bodyValidation,
                    summary:
                        isStory
                        && (values.summary.length > 140
                            ? tt('reply_editor.shorten_summary')
                            : markdownRegex.test(values.summary)
                                ? tt('reply_editor.markdown_not_supported')
                                : htmlTagRegex.test(values.summary) ? tt('reply_editor.html_not_supported') : null),
                    altAuthor:
                        isStory
                        && (values.altAuthor.length > 50
                            ? tt('reply_editor.shorten_alt_author')
                            : values.altAuthor && !altAuthorAllowedCharactersRegex.test(values.altAuthor)
                                ? tt('reply_editor.invalid_username')
                                : null),
                };
            },
        });
    }

    onCancel = (e) => {
        if (e) e.preventDefault();
        const { formId, onCancel, defaultPayoutType } = this.props;
        const { replyForm, body } = this.state;
        // eslint-disable-next-line no-restricted-globals
        if (!body.value || confirm(tt('reply_editor.are_you_sure_you_want_to_clear_this_form'))) {
            replyForm.resetForm();
            if (this.refs.rte) this.refs.rte.setState({ state: stateFromHtml() });
            this.setState({ progress: {} });
            this.props.setPayoutType(formId, defaultPayoutType);
            this.props.setBeneficiaries(formId, []);
            this.props.setMaxAcceptedPayout(formId, null);
            if (onCancel) onCancel(e);
        }
    };

    // As rte_editor is updated, keep the (invisible) 'body' field in sync.
    onChange = (rte_value) => {
        const { body } = this.state;
        body.props.onChange(rte_value);
    };

    toggleRte = (e) => {
        e.preventDefault();
        const state = { rte: !this.state.rte };
        if (state.rte) {
            const { body } = this.state;
            state.rte_value = isHtmlTest(body.value) ? stateFromHtml(body.value) : stateFromMarkdown(body.value);
        }
        this.setState(state);
        localStorage.setItem('replyEditorData-rte', !this.state.rte);
    };

    showDraftSaved() {
        if (this.draftRef.current) {
            this.draftRef.current.className = 'ReplyEditor__draft';
            // eslint-disable-next-line no-void
            void this.draftRef.current.offsetWidth; // reset animation
            this.draftRef.current.className = 'ReplyEditor__draft ReplyEditor__draft-saved';
        }
    }

    showAdvancedSettings = (e) => {
        e.preventDefault();

        this.props.setPayoutType(this.props.formId, this.props.payoutType);

        if (this.props.payoutType === '0%') {
            this.props.setMaxAcceptedPayout(this.props.formId, 0);
        } else {
            this.props.setMaxAcceptedPayout(this.props.formId, this.props.maxAcceptedPayout);
        }

        this.props.showAdvancedSettings(this.props.formId);
    };

    displayErrorMessage = (message) => {
        this.setState({
            progress: { error: message },
        });

        setTimeout(() => {
            this.setState({ progress: {} });
        }, 6000); // clear message
    };

    onDrop = (acceptedFiles, rejectedFiles) => {
        if (!acceptedFiles.length) {
            if (rejectedFiles.length) {
                this.displayErrorMessage('Please insert only image files.');
                console.log('onDrop Rejected files: ', rejectedFiles);
            }
            return;
        }

        if (acceptedFiles.length > MAX_FILE_TO_UPLOAD) {
            this.displayErrorMessage(`Please upload up to maximum ${MAX_FILE_TO_UPLOAD} images.`);
            console.log('onDrop too many files to upload');
            return;
        }

        for (let fi = 0; fi < acceptedFiles.length; fi += 1) {
            const acceptedFile = acceptedFiles[fi];
            const imageToUpload = {
                file: acceptedFile,
                temporaryTag: '',
            };
            imagesToUpload.push(imageToUpload);
        }

        this.insertPlaceHolders();
        this.uploadNextImage();
    };

    onOpenClick = () => {
        this.dropzoneRef.current.open();
    };

    onPasteCapture = (e) => {
        try {
            if (e.clipboardData) {
                // @TODO: currently it seems to capture only one file, try to find a fix for multiple files
                for (const item of e.clipboardData.items) {
                    if (item.kind === 'file' && /^image\//.test(item.type)) {
                        const blob = item.getAsFile();
                        imagesToUpload.push({
                            file: blob,
                            temporaryTag: '',
                        });
                    }
                }

                this.insertPlaceHolders();
                this.uploadNextImage();
            } else {
                // http://joelb.me/blog/2011/code-snippet-accessing-clipboard-images-with-javascript/
                // contenteditable element that catches all pasted data
                this.setState({ noClipboardData: true });
            }
        } catch (error) {
            console.error('Error analyzing clipboard event', error);
        }
    };

    uploadNextImage = () => {
        if (imagesToUpload.length > 0) {
            const nextImage = imagesToUpload.pop();
            this.upload(nextImage);
        }
    };

    insertPlaceHolders = () => {
        let { imagesUploadCount } = this.state;
        const { body } = this.state;
        const { selectionStart } = this.textareaRef.current;
        let placeholder = '';

        for (let ii = 0; ii < imagesToUpload.length; ii += 1) {
            const imageToUpload = imagesToUpload[ii];

            if (imageToUpload.temporaryTag === '') {
                imagesUploadCount += 1;
                imageToUpload.temporaryTag = `![Uploading image #${imagesUploadCount}...]()`;
                placeholder += `\n${imageToUpload.temporaryTag}\n`;
            }
        }

        this.setState({ imagesUploadCount });

        // Insert the temporary tag where the cursor currently is
        body.props.onChange(
            body.value.substring(0, selectionStart)
            + placeholder
            + body.value.substring(selectionStart, body.value.length)
        );
    };

    upload = (image) => {
        const { uploadImage } = this.props;
        this.setState({
            progress: { message: tt('reply_editor.uploading') },
        });

        uploadImage(image.file, (progress) => {
            const { body } = this.state;

            if (progress.url) {
                this.setState({ progress: {} });
                const { url } = progress;
                const imageMd = `![${image.file.name}](${url})`;

                // Replace temporary image MD tag with the real one
                body.props.onChange(body.value.replace(image.temporaryTag, imageMd));

                this.uploadNextImage();
            } else if (Object.prototype.hasOwnProperty.call(progress, 'error')) {
                this.displayErrorMessage(progress.error);
                const imageMd = `![${image.file.name}](UPLOAD FAILED)`;

                // Remove temporary image MD tag
                body.props.onChange(body.value.replace(image.temporaryTag, imageMd));
            } else {
                this.setState({ progress });
            }
        });
    };

    render() {
        const originalPost = {
            category: this.props.category,
            body: this.props.body,
        };
        const { onCancel } = this;
        const {
            title, tags, summary, altAuthor, body, community, enableSideBySide
        } = this.state;
        const {
            reply,
            username,
            isStory,
            formId,
            author,
            permlink,
            parent_author,
            parent_permlink,
            type,
            jsonMetadata,
            successCallback,
            defaultPayoutType,
            payoutType,
            beneficiaries,
            maxAcceptedPayout,
        } = this.props;
        const {
            submitting, valid, handleSubmit, resetForm,
        } = this.state.replyForm;
        const { postError, rte, userRc } = this.state;
        const { progress, noClipboardData } = this.state;
        const disabled = submitting || !valid;
        const loading = submitting || this.state.loading;

        let accountStats;
        let rcStats = '';
        if (userRc) {
            accountStats = calculateRcStats(userRc);
            const { resourceCreditsPercent, resourceCreditsWaitTime } = accountStats;
            rcStats = tt('g.rcLevel', { rc_percent: resourceCreditsPercent });

            if (resourceCreditsWaitTime > 0) {
                rcStats += ` ${tt('g.rcFullIn', { duration: HumanizeDuration(resourceCreditsWaitTime * 1000, { largest: 2 }) })}`;
            }
        }

        let selectedCoverImage = '';
        const jsonMetadataImages = _.get(jsonMetadata, 'image', []);
        if (jsonMetadataImages && jsonMetadataImages.length > 0) {
            selectedCoverImage = _.get(jsonMetadataImages, '[0]');
        }

        // Generate an array of images used in the post body.
        // This will be used to display the cover image selector.
        let rtags;
        if (isStory) {
            rtags = extractRtags(body.value);
        }

        const errorCallback = (estr) => {
            this.setState({ postError: estr, loading: false });
        };
        const isEdit = type === 'edit';
        const successCallbackWrapper = (...args) => {
            if (!isEdit) {
                resetForm();
            }
            this.setState({ loading: false });
            this.props.setPayoutType(formId, defaultPayoutType);
            this.props.setBeneficiaries(formId, []);
            this.props.setMaxAcceptedPayout(formId, null);
            if (successCallback) successCallback(args);
        };
        const isHtml = rte || isHtmlTest(body.value);
        const replyParams = {
            author,
            permlink,
            parent_author,
            parent_permlink,
            type,
            username,
            originalPost,
            isHtml,
            isStory,
            jsonMetadata,
            payoutType,
            beneficiaries,
            maxAcceptedPayout,
            successCallback: successCallbackWrapper,
            errorCallback,
        };
        const postLabel = username ? (
            <Tooltip content={tt('g.post_as_user', { username })}>{tt('g.post')}</Tooltip>
        ) : (
            tt('g.post')
        );
        const hasTitleError = title && title.touched && title.error;
        let titleError = null;
        // The Required title error (triggered onBlur) can shift the form making it hard to click on things..
        if (hasTitleError && (title.error !== tt('g.required') || body.value !== '')) {
            titleError = (
                <div className={hasTitleError ? 'error' : 'warning'}>
                    {title.error}
                    &nbsp;
                </div>
            );
        }

        const hasSummaryError = summary && summary.touched && summary.error;
        let summaryError = null;
        if (hasSummaryError) {
            summaryError = (
                <div className={hasSummaryError ? 'error' : 'warning'}>
                    {summary.error}
                    &nbsp;
                </div>
            );
        }

        const hasAltAuthorError = altAuthor && altAuthor.touched && altAuthor.error;
        let altAuthorError = null;
        if (hasAltAuthorError) {
            altAuthorError = (
                <div className={hasAltAuthorError ? 'error' : 'warning'}>
                    {altAuthor.error}
                    &nbsp;
                </div>
            );
        }

        // TODO: remove all references to these vframe classes. Removed from css and no longer needed.
        const vframe_section_class = isStory ? 'vframe__section' : '';
        const vframe_section_shrink_class = isStory ? 'vframe__section--shrink' : '';

        const toggleSideBySide = () => {
            this.setState({
                enableSideBySide: !enableSideBySide,
            });
        };

        const onSelectCoverImage = (event) => {
            const { target } = event;

            const postImages = document.getElementsByClassName('ReplyEditor__options__image_selector__image_container');
            for (let pi = 0; pi < postImages.length; pi += 1) {
                const postImage = postImages[pi];
                postImage.classList.remove('selected');
            }

            target.classList.add('selected');
            selectedCoverImage = target.style.backgroundImage.slice(4, -1).replace(/"/g, '');
        };

        return (
            <div
                className={classnames({
                    ReplyEditor: true,
                    row: true,
                    'side-by-side': enableSideBySide,
                })}
            >
                <div
                    className={classnames({
                        column: true,
                        'small-12': true,
                        'large-6': enableSideBySide,
                    })}
                >
                    <div ref={this.draftRef} className="ReplyEditor__draft ReplyEditor__draft-hide">
                        {tt('reply_editor.draft_saved')}
                    </div>
                    <form
                        className={classnames({
                            vframe_class: true,
                            'side-by-side': enableSideBySide,
                        })}
                        onSubmit={handleSubmit(({ data }) => {
                            const startLoadingIndicator = () => this.setState({
                                loading: true,
                                postError: undefined,
                            });
                            const replyPayload = {
                                ...data,
                                ...replyParams,
                                startLoadingIndicator,
                                selectedCoverImage,
                            };
                            reply(replyPayload);
                        })}
                        onChange={() => {
                            this.setState({ postError: null });
                        }}
                    >
                        <div className={vframe_section_shrink_class}>
                            <a href="#" onClick={toggleSideBySide}>
                                {(enableSideBySide && tt('reply_editor.disable_sidebyside'))
                                || tt('reply_editor.enable_sidebyside')}
                            </a>
                        </div>
                        <div className={vframe_section_shrink_class}>
                            {isStory && (
                                <span>
                                    <input
                                        type="text"
                                        className="ReplyEditor__title"
                                        onChange={title.props.onChange}
                                        disabled={loading}
                                        placeholder={tt('reply_editor.title')}
                                        autoComplete="off"
                                        ref={this.titleRef}
                                        tabIndex={0}
                                        {...title.props}
                                    />
                                    {titleError}
                                    <div className="float-left primary" style={{ margin: '0.8rem 0 0 0' }}>
                                        {rte && (
                                            <a href="#" onClick={this.toggleRte}>
                                                🗒️
                                                {' '}
                                                {tt('reply_editor.enable_markdown_editor')}
                                            </a>
                                        )}
                                        {!rte && (
                                            <a href="#" onClick={this.toggleRte}>
                                                {`📰 ${tt('reply_editor.editor')}`}
                                            </a>
                                        )}
                                    </div>
                                </span>
                            )}
                        </div>

                        <div
                            className={
                                'ReplyEditor__body Markdown '
                                + (rte ? `rte ${vframe_section_class}` : vframe_section_shrink_class)
                            }
                        >
                            {process.env.BROWSER && rte ? (
                                <VisualEditor onChange={this.onChange} value={body.value} />
                            ) : (
                                <span>
                                    <Dropzone
                                        onDrop={this.onDrop}
                                        className={type === 'submit_story' ? 'dropzone' : 'none'}
                                        noClick
                                        multiple
                                        accept="image/*"
                                        ref={this.dropzoneRef}
                                    >
                                        {({getRootProps, getInputProps}) => {
                                            const inputProps = getInputProps();
                                            delete inputProps.onClick;

                                            return (
                                                <div {...getRootProps()}>
                                                    <textarea
                                                        {...body.props}
                                                        ref={this.textareaRef}
                                                        onPasteCapture={this.onPasteCapture}
                                                        className={type === 'submit_story' ? 'upload-enabled' : ''}
                                                        disabled={loading}
                                                        rows={isStory ? 10 : 3}
                                                        placeholder={isStory ? tt('g.write_your_story') : tt('g.reply')}
                                                        autoComplete="off"
                                                        tabIndex={0}
                                                    />
                                                    <input {...inputProps} />
                                                </div>
                                            );
                                        }}
                                    </Dropzone>
                                    {progress.message && <div className="info">{progress.message}</div>}
                                    {progress.error && (
                                        <div className="error">
                                            {tt('reply_editor.image_upload')}
                                            :
                                            {' '}
                                            {progress.error}
                                        </div>
                                    )}
                                </span>
                            )}
                        </div>
                        {!rte && (
                            <p className="drag-and-drop">
                                {tt('reply_editor.insert_images_by_dragging_dropping')}
                                {noClipboardData ? '' : tt('reply_editor.pasting_from_the_clipboard')}
                                {tt('reply_editor.or_by')}
                                {' '}
                                <a role="link" tabIndex={0} onClick={this.onOpenClick}>{tt('reply_editor.selecting_them')}</a>
                                .
                            </p>
                        )}
                        <div className={vframe_section_shrink_class}>
                            <div className="error">
                                {body.touched && body.error && body.error !== 'Required' && body.error}
                            </div>
                        </div>

                        <div className={vframe_section_shrink_class} style={{ marginTop: '0.5rem' }}>
                            {isStory && (
                                <span>
                                    <input
                                        type="text"
                                        className="ReplyEditor__summary"
                                        onChange={summary.props.onChange}
                                        disabled={loading}
                                        placeholder={tt('reply_editor.summary')}
                                        autoComplete="off"
                                        ref="summaryRef"
                                        tabIndex={0}
                                        {...summary.props}
                                    />
                                </span>
                            )}
                            {summaryError}
                        </div>

                        <div className={vframe_section_shrink_class} style={{ marginTop: '0.5rem' }}>
                            {isStory && (
                                <span>
                                    <TagInput
                                        {...tags.props}
                                        onChange={tags.props.onChange}
                                        disabled={loading}
                                        isEdit={isEdit}
                                        tabIndex={0}
                                    />
                                    {(tags.touched || tags.value) && (
                                        <div className="error">
                                            {tags.error}
                                            {' '}
                                        </div>
                                    )}
                                </span>
                            )}
                        </div>

                        <div className={vframe_section_shrink_class} style={{ marginTop: '0.5rem' }}>
                            {isStory && (
                                <span>
                                    <input
                                        type="text"
                                        className="ReplyEditor__altAuthor"
                                        onChange={altAuthor.props.onChange}
                                        disabled={loading}
                                        placeholder={tt('reply_editor.alt_author')}
                                        autoComplete="off"
                                        ref="altAuthorref"
                                        tabIndex={0}
                                        {...altAuthor.props}
                                    />
                                </span>
                            )}
                            {altAuthorError}
                        </div>

                        {isStory && (
                            <div>
                                {Array.from(rtags.images).length > 0 && (
                                    <div className="ReplyEditor__options__cover_image_selector">
                                        <h5>
                                            {tt('reply_editor.select_cover_image')}
                                            :
                                        </h5>
                                        <div className="ReplyEditor__options__image_selector">
                                            {Array.from(rtags.images).map((image) => {
                                                return (
                                                    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                                                    <div
                                                        key={image}
                                                        className={classnames(
                                                            'ReplyEditor__options__image_selector__image_container',
                                                            {
                                                                selected: image === selectedCoverImage,
                                                            }
                                                        )}
                                                        style={{
                                                            backgroundImage: `url(${image})`,
                                                        }}
                                                        onClick={onSelectCoverImage}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        <div className={vframe_section_shrink_class} style={{ marginTop: '0.5rem' }}>
                            {isStory
                            && !isEdit && (
                                <div className="ReplyEditor__options">
                                    <h5>
                                        {tt('reply_editor.post_options')}
                                        :
                                    </h5>
                                    <div>
                                        {this.props.maxAcceptedPayout !== null
                                        && this.props.maxAcceptedPayout !== 0 && (
                                            <div>
                                                {tt('post_advanced_settings_jsx.max_accepted_payout')}
                                                {': '}
                                                {this.props.maxAcceptedPayout}
                                                {' '}
                                                HBD
                                            </div>
                                        )}
                                        <div>
                                            {tt('post_advanced_settings_jsx.payout_option_header')}
                                            {': '}
                                            {this.props.payoutType === '0%' && tt('reply_editor.decline_payout')}
                                            {this.props.payoutType === '50%' && tt('reply_editor.default_50_50')}
                                            {this.props.payoutType === '100%' && tt('reply_editor.power_up_100')}
                                        </div>
                                        <div>
                                            {beneficiaries
                                            && beneficiaries.length > 0 && (
                                                <span>
                                                    {tt('g.beneficiaries')}
                                                    {': '}
                                                    {tt('reply_editor.beneficiaries_set', {
                                                        count: beneficiaries.length,
                                                    })}
                                                </span>
                                            )}
                                        </div>
                                        <Tooltip
                                            content={<FormattedHTMLMessage id="reply_editor.advanced_tooltip" />}
                                            arrow={false}
                                        >
                                            <a href="#" onClick={this.showAdvancedSettings}>
                                                {tt('reply_editor.advanced_settings')}
                                            </a>
                                        </Tooltip>
                                        {' '}
                                        <br />
                                    </div>
                                </div>
                            )}
                        </div>
                        {rcStats && (
                            <div className={vframe_section_shrink_class} style={{ marginTop: '0.5rem' }}>
                                <div className="ReplyEditor__options">
                                    <h5>
                                        Account stats:
                                    </h5>
                                    <div>
                                        <Tooltip
                                            content={<FormattedHTMLMessage id="reply_editor.rc_tooltip" />}
                                            arrow={false}
                                        >
                                            {rcStats}
                                        </Tooltip>
                                    </div>
                                    {' '}
                                    <br />
                                </div>
                            </div>
                        )}

                        <div className={vframe_section_shrink_class}>
                            {postError && <div className="error">{postError}</div>}
                        </div>

                        <div
                            className={classnames(vframe_section_shrink_class, 'ReplyEditor--submit-buttons-container')}
                        >
                            {isStory
                            && !isEdit
                            && username && (
                                <PostCategoryBanner
                                    category={community}
                                    username={username}
                                    onChange={this.onPostDestinationChange}
                                />
                            )}
                            {!loading && (
                                <button type="submit" className="button" disabled={disabled} tabIndex={0}>
                                    {isEdit ? tt('reply_editor.update_post') : postLabel}
                                </button>
                            )}
                            {loading && (
                                <span>
                                    <br />
                                    <LoadingIndicator type="circle" />
                                </span>
                            )}
                            &nbsp;
                            {' '}
                            {!loading
                            && this.props.onCancel && (
                                <button
                                    type="button"
                                    className="secondary hollow button no-border"
                                    tabIndex={0}
                                    onClick={onCancel}
                                >
                                    {tt('g.cancel')}
                                </button>
                            )}
                            {!loading
                            && !this.props.onCancel && (
                                <button
                                    type="button"
                                    className="button hollow no-border"
                                    tabIndex={0}
                                    disabled={submitting}
                                    onClick={onCancel}
                                >
                                    {tt('g.clear')}
                                </button>
                            )}
                            {!isStory
                            && !isEdit
                            && this.props.payoutType != '50%' && (
                                <div className="ReplyEditor__options float-right text-right">
                                    {tt('g.rewards')}
                                    {': '}
                                    {this.props.payoutType == '0%' && tt('reply_editor.decline_payout')}
                                    {this.props.payoutType == '100%' && tt('reply_editor.power_up_100')}
                                    {'. '}
                                    <a href={'/@' + username + '/settings'}>Update settings</a>
                                </div>
                            )}
                        </div>
                    </form>
                </div>
                <div
                    className={classnames({
                        column: true,
                        'small-12': true,
                        'large-6': enableSideBySide,
                        'preview-container': true,
                        'side-by-side': enableSideBySide,
                    })}
                >
                    <div className="Preview-info">
                        <h6>{tt('g.preview')}</h6>
                        {!isHtml && (
                            <div>
                                <a
                                    target="_blank"
                                    href="https://guides.github.com/features/mastering-markdown/"
                                    rel="noopener noreferrer"
                                >
                                    {tt('reply_editor.markdown_styling_guide')}
                                </a>
                            </div>
                        )}
                    </div>
                    {!loading
                    && body.value && (
                        <div
                            className={classnames({
                                Preview: true,
                                'side-by-side': enableSideBySide,
                                vframe_section_shrink_class: true,
                            })}
                        >
                            <MarkdownViewer text={body.value} large={isStory} />
                        </div>
                    )}
                </div>
            </div>
        );
    }
}

let saveEditorTimeout;

// See also MarkdownViewer render
const isHtmlTest = (text) => /^<html>/.test(text);

function stateFromHtml() {
    return null;
    /*
        if (html) html = stripHtmlWrapper(html);
        if (html && html.trim() == '') html = null;
        return html ? deserializeHtml(html) : getDemoState();

     */
}

//var htmlclean = require('htmlclean');
function stateFromMarkdown(markdown) {
    let html;
    if (markdown && markdown.trim() !== '') {
        html = remarkable.render(markdown);
        html = HtmlReady(html).html; // TODO: option to disable youtube conversion, @-links, img proxy
        //html = htmlclean(html) // normalize whitespace
    }
    return stateFromHtml(html);
}

export default (formId) => connect(
    // mapStateToProps
    (state, ownProps) => {
        const username = state.user.getIn(['current', 'username']);
        const referralSystem = state.app.getIn(['user_preferences', 'referralSystem']);
        const defaultBeneficiaries = state.user.getIn(['current', 'defaultBeneficiaries']);
        const fields = ['body'];
        const {
            author, permlink, type, parent_author
        } = ownProps;
        const isEdit = type === 'edit';
        const isStory = /submit_story/.test(type) || (isEdit && !parent_author);
        if (isStory) fields.push('title');
        if (isStory) fields.push('tags');
        if (isStory) fields.push('summary');
        if (isStory) fields.push('altAuthor');

        const { summary, altAuthor } = ownProps;
        let { category, title, body } = ownProps;
        if (/submit_/.test(type)) {
            title = '';
            body = '';
        }
        // type: PropTypes.oneOf(['submit_story', 'submit_comment', 'edit'])

        const {query} = state.routing.locationBeforeTransitions;
        if (query && query.category) {
            category = query.category;
        }

        const jsonMetadata = ownProps.jsonMetadata
            ? ownProps.jsonMetadata instanceof Map ? ownProps.jsonMetadata.toJS() : ownProps.jsonMetadata
            : {};

        let tags = category;
        if (isStory && jsonMetadata && jsonMetadata.tags) {
            tags = OrderedSet([category, ...jsonMetadata.tags]).join(' ');
        }
        let isNSFWCommunity = false;
        isNSFWCommunity = state.global.getIn(['community', category, 'is_nsfw']);
        if (isNSFWCommunity) {
            tags = `${tags} nsfw`;
        }
        const defaultPayoutType = state.app.getIn(
            ['user_preferences', isStory ? 'defaultBlogPayout' : 'defaultCommentPayout'],
            '50%'
        );
        let payoutType = state.user.getIn(['current', 'post', formId, 'payoutType']);
        let maxAcceptedPayout;
        if (isEdit) {
            maxAcceptedPayout = parseFloat(
                state.global.getIn(['content', `${author}/${permlink}`, 'max_accepted_payout'])
            );
        } else {
            maxAcceptedPayout = state.user.getIn(['current', 'post', formId, 'maxAcceptedPayout']);
        }
        if (!payoutType) {
            payoutType = defaultPayoutType;
        }
        let beneficiaries = state.user.getIn(['current', 'post', formId, 'beneficiaries']);
        const postTemplateName = state.user.getIn(['current', 'post', formId, 'postTemplateName']);
        beneficiaries = beneficiaries ? beneficiaries.toJS() : [];

        // Post full
        /*
        const replyParams = {
            author,
            permlink,
            parent_author,
            parent_permlink,
            category,
            title,
            body: post.get('body'),
        }; */

        //ownProps:
        //  {...comment},
        //  author, permlink,
        //  body, title, category
        //  parent_author, parent_permlink,
        //  type, successCallback,
        //  successCallBack, onCancel
        return {
            ...ownProps,
            type, //XX
            jsonMetadata, //XX (if not reply)
            category,
            fields,
            isStory,
            username,
            referralSystem,
            defaultBeneficiaries,
            defaultPayoutType,
            payoutType,
            beneficiaries,
            postTemplateName,
            maxAcceptedPayout,
            initialValues: {
                title, summary, altAuthor, body, tags
            },
            formId,
        };
    },

    // mapDispatchToProps
    (dispatch) => ({
        uploadImage: (file, progress) => dispatch(userActions.uploadImage({ file, progress })),
        showAdvancedSettings: (_formId) => dispatch(userActions.showPostAdvancedSettings({ _formId })),
        setPayoutType: (_formId, payoutType) => dispatch(
            userActions.set({
                key: ['current', 'post', _formId, 'payoutType'],
                value: payoutType,
            })
        ),
        setMaxAcceptedPayout: (_formId, maxAcceptedPayout) => dispatch(
            userActions.set({
                key: ['current', 'post', _formId, 'maxAcceptedPayout'],
                value: maxAcceptedPayout,
            })
        ),
        setBeneficiaries: (_formId, beneficiaries) => dispatch(
            userActions.set({
                key: ['current', 'post', _formId, 'beneficiaries'],
                value: fromJS(beneficiaries),
            })
        ),
        setPostTemplateName: (_formId, postTemplateName) => dispatch(
            userActions.set({
                key: ['current', 'post', _formId, 'postTemplateName'],
                value: postTemplateName,
            })
        ),
        reply: ({
                    tags,
                    title,
                    summary,
                    altAuthor,
                    body,
                    author,
                    permlink,
                    parent_author,
                    parent_permlink,
                    isHtml,
                    isStory,
                    type,
                    originalPost,
                    payoutType = '50%',
                    maxAcceptedPayout = null,
                    beneficiaries = [],
                    username,
                    jsonMetadata,
                    successCallback,
                    errorCallback,
                    startLoadingIndicator,
                    selectedCoverImage,
                }) => {
            const isEdit = type === 'edit';
            const isNew = /^submit_/.test(type);

            // Wire up the current and parent props for either an Edit or a Submit (new post)
            //'submit_story', 'submit_comment', 'edit'
            const linkProps = isNew
                ? {
                    // submit new
                    parent_author: author,
                    parent_permlink: permlink,
                    author: username,
                    // permlink,  assigned in TransactionSaga
                }
                : isEdit ? { // edit existing
                    author, permlink, parent_author, parent_permlink
                } : null;

            if (!linkProps) throw new Error('Unknown type: ' + type);

            let rtags;
            {
                const html = isHtml ? body : remarkable.render(body);
                rtags = HtmlReady(html, { mutate: false });
            }

            allowedTags.forEach((tag) => {
                rtags.htmltags.delete(tag);
            });
            if (isHtml) rtags.htmltags.delete('html'); // html tag allowed only in HTML mode
            if (rtags.htmltags.size) {
                errorCallback(
                    'Please remove the following HTML elements from your post: '
                    + Array(...rtags.htmltags)
                        .map((tag) => `<${tag}>`)
                        .join(', ')
                );
                return;
            }

            const metaTags = allTags(tags, originalPost.category, rtags.hashtags);

            // merge
            const meta = isEdit ? jsonMetadata : {};

            if (metaTags.size) {
                meta.tags = metaTags.toJS();
            } else {
                delete meta.tags;
            }

            if (rtags.usertags.size) {
                meta.users = Array.from(rtags.usertags);
            } else {
                delete meta.users;
            }

            if (rtags.images.size) {
                const moveToFirst = (array, first) => {
                    array.sort((x, y) => {
                        return x === first ? -1 : y === first ? 1 : 0;
                    });
                };
                meta.image = Array.from(rtags.images);

                // If a cover image has been manually selected,
                // move it to the first element of the image array.
                if (selectedCoverImage) {
                    moveToFirst(meta.image, selectedCoverImage);
                }
            } else {
                delete meta.image;
            }
            if (rtags.links.size) {
                meta.links = Array.from(rtags.links).slice(0, 1);
            } else {
                delete meta.links;
            }

            meta.app = 'hiveblog/0.1';
            if (isStory) {
                meta.format = isHtml ? 'html' : 'markdown';
                if (summary) {
                    meta.description = summary;
                }
                if (altAuthor) {
                    meta.author = altAuthor;
                }
            }

            const sanitizeErrors = [];
            sanitize(body, sanitizeConfig({ sanitizeErrors }));
            if (sanitizeErrors.length) {
                errorCallback(sanitizeErrors.join('.  '));
                return;
            }

            if (meta.tags && meta.tags.length > MAX_TAGS) {
                const includingCategory = isEdit
                    ? tt('reply_editor.including_the_category', {
                        rootCategory: originalPost.category,
                    })
                    : '';
                errorCallback(
                    tt('reply_editor.use_limited_amount_of_tags', {
                        tagsLength: meta.tags.length,
                        includingCategory,
                    })
                );
                return;
            }

            startLoadingIndicator();

            const originalBody = isEdit ? originalPost.body : null;
            const __config = {
                originalBody,
                comment_options: isEdit ? null : {},
            };
            // Avoid changing payout option during edits #735
            if (!isEdit) {
                switch (payoutType) {
                    case '0%': // decline payout
                        __config.comment_options.max_accepted_payout = '0.000 HBD';
                        break;
                    case '100%': // 100% steem power payout
                        __config.comment_options.percent_hbd = 0; // 10000 === 100% (of 50%)
                        break;
                    default: // 50% steem power, 50% sd+steem
                }
                if (beneficiaries && beneficiaries.length > 0) {
                    __config.comment_options.extensions = [
                        [
                            0,
                            {
                                beneficiaries: beneficiaries
                                    .sort(
                                        (a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
                                    )
                                    .map((elt) => ({
                                        account: elt.username,
                                        weight: parseInt(elt.percent) * 100,
                                    })),
                            },
                        ],
                    ];
                }
                if (maxAcceptedPayout !== null && maxAcceptedPayout !== 0) {
                    __config.comment_options.max_accepted_payout = `${maxAcceptedPayout.toFixed(3)} HBD`;
                }
            }

            const operation = {
                ...linkProps,
                category: originalPost.category || metaTags.first(),
                title,
                body,
                json_metadata: JSON.stringify(meta),
                __config,
            };

            dispatch(
                transactionActions.broadcastOperation({
                    type: 'comment',
                    operation,
                    errorCallback,
                    successCallback,
                })
            );
        },
    })
)(ReplyEditor);
