/*global $STM_Config*/
/* eslint react/prop-types: 0 */
import React, { Component } from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';
import * as transactionActions from 'app/redux/TransactionReducer';
import * as globalActions from 'app/redux/GlobalReducer';
import * as userActions from 'app/redux/UserReducer';
import { validate_account_name } from 'app/utils/ChainValidation';
import { hasCompatibleKeychain } from 'app/utils/HiveKeychain';
import runTests from 'app/utils/BrowserTests';
// import shouldComponentUpdate  from 'app/utils/shouldComponentUpdate';
import reactForm from 'app/utils/ReactForm';
import { serverApiRecordEvent } from 'app/utils/ServerApiClient';
import tt from 'counterpart';
import { APP_URL } from 'app/client_config';
import { PrivateKey, PublicKey } from '@hiveio/hive-js/lib/auth/ecc';
import { SIGNUP_URL } from 'shared/constants';
import PdfDownload from 'app/components/elements/PdfDownload';
import { hiveSignerClient } from 'app/utils/HiveSigner';
import { getQueryStringParams } from 'app/utils/Links';

import { connect } from 'react-redux';

class LoginForm extends Component {
    static propTypes = {
        // Steemit.
        loginError: PropTypes.string,
        onCancel: PropTypes.func,
        afterLoginRedirectToWelcome: PropTypes.bool,
    };

    static defaultProps = {
        loginError: '',
        onCancel: undefined,
        afterLoginRedirectToWelcome: false,
    };

    constructor(props) {
        super();
        const cryptoTestResult = runTests();
        let cryptographyFailure = false;
        const isHiveSigner = false;
        this.SignUp = this.SignUp.bind(this);
        if (cryptoTestResult !== undefined) {
            console.error('CreateAccount - cryptoTestResult: ', cryptoTestResult);
            cryptographyFailure = true;
        }
        const oauthFlow = null;
        this.state = {
            cryptographyFailure,
            isHiveSigner,
            isProcessingHiveAuth: false,
            oauthFlow,
            oauthFlowLoading: true,
            oauthFlowError: false,
        };
        this.usernameOnChange = (e) => {
            const value = e.target.value.toLowerCase();
            this.state.username.props.onChange(value);
        };
        this.onCancel = (e) => {
            if (e.preventDefault) e.preventDefault();
            const { onCancel, loginBroadcastOperation } = this.props;
            const errorCallback = loginBroadcastOperation && loginBroadcastOperation.get('errorCallback');
            if (errorCallback) errorCallback('Canceled');
            if (onCancel) onCancel();
        };
        this.qrReader = () => {
            const { qrReader } = props;
            const { password } = this.state;
            qrReader((data) => {
                password.props.onChange(data);
            });
        };
        this.initForm(props);
    }

    async componentDidMount() {
        this.loginWithHiveSigner();
        // eslint-disable-next-line react/no-string-refs
        if (this.refs.username && !this.refs.username.value) this.refs.username.focus();
        // eslint-disable-next-line react/no-string-refs
        if (this.refs.username && this.refs.username.value) this.refs.pw.focus();

        // This is asynchronous!
        await this.registerOauthRequest();
    }

    componentDidUpdate() {
        const { loginError } = this.props;
        if (loginError && this.state.isProcessingHiveAuth) {
            // eslint-disable-next-line react/no-did-update-set-state
            this.setState({ isProcessingHiveAuth: false });
        }
    }

    componentWillUnmount() {
        this.unRegisterOauthRequest();
    }

    // shouldComponentUpdate = shouldComponentUpdate(this, 'LoginForm');

    initForm(props) {
        reactForm({
            name: 'login',
            instance: this,
            fields: ['username', 'password', 'saveLogin:checked', 'useKeychain:checked', 'useHiveAuth:checked'],
            initialValues: props.initialValues,
            validation: (values) => ({
                username: !values.username ? tt('g.required') : validate_account_name(values.username.split('/')[0]),
                password: values.useKeychain
                    ? null
                    : values.useHiveAuth
                        ? null
                        : !values.password
                            ? tt('g.required')
                            : PublicKey.fromString(values.password)
                                ? tt('loginform_jsx.you_need_a_private_password_or_key')
                                : null,
            }),
        });
    }

    SignUp() {
        const onType = document.getElementsByClassName('OpAction')[0].textContent;
        serverApiRecordEvent('FreeMoneySignUp', onType);
        window.location.href = SIGNUP_URL;
    }

    useKeychainToggle = () => {
        const { useKeychain, useHiveAuth } = this.state;
        useKeychain.props.onChange(!useKeychain.value);
        useHiveAuth.props.onChange(false);
    };

    useHiveAuthToggle = () => {
        const { useHiveAuth, useKeychain } = this.state;
        useHiveAuth.props.onChange(!useHiveAuth.value);
        useKeychain.props.onChange(false);
    };

    saveLoginToggle = () => {
        const { saveLogin } = this.state;
        saveLoginDefault = !saveLoginDefault;
        localStorage.setItem('saveLogin', saveLoginDefault ? 'yes' : 'no');
        saveLogin.props.onChange(saveLoginDefault); // change UI
    };

    onClickHiveSignerBtn = () => {
        const { saveLogin } = this.state;
        const { afterLoginRedirectToWelcome } = this.props;
        hiveSignerClient.login({
            state: JSON.stringify({
                lastPath: window.location.pathname,
                saveLogin: saveLogin.value,
                afterLoginRedirectToWelcome,
            }),
        });
    };


    async registerOauthRequest() {
        const params = new URLSearchParams(window.location.search);

        if (!$STM_Config.oauth_server_enable
                || !params.has('login_challenge')
                ) {
            this.setState({
                oauthFlowLoading: false,
                oauthFlowError: false,
            });
            return;
        }

        const headers = {
            Accept: 'application/json',
        };
        const requestParams = {
            login_challenge: params.get('login_challenge')
        };

        let oauthFlow;
        try {
            oauthFlow = (
                await axios.get(
                    '/oauth/login', {headers, params: requestParams}
                    )
                ).data;
        } catch (error) {
            this.setState({
                oauthFlowLoading: false,
                oauthFlowError: true,
            });
            return;
        }

        try {
            sessionStorage.setItem(
                'oauth',
                (new URLSearchParams(requestParams)).toString()
                );
            this.setState({
                oauthFlow,
                oauthFlowLoading: false,
                oauthFlowError: false,
            });
        } catch (error) {
            this.setState({
                oauthFlowLoading: false,
                oauthFlowError: true,
            });
            // Do nothing – sessionStorage is unavailable, probably.
        }
    }

    unRegisterOauthRequest() {
        try {
            sessionStorage.removeItem('oauth');
        } catch (error) {
            // Do nothing – sessionStorage is unavailable, probably.
        }
    }

    loginWithHiveSigner = () => {
        const path = window.location.pathname;
        if (path === '/login/hivesigner') {
            this.setState({
                isHiveSigner: true,
            });
            const params = getQueryStringParams(window.location.search);
            const {
                username, access_token, expires_in, state
            } = params;
            const {
                saveLogin,
                afterLoginRedirectToWelcome,
                lastPath,
            } = JSON.parse(decodeURI(state));
            const { reallySubmit, loginBroadcastOperation } = this.props;
            const data = {
                username,
                access_token,
                expires_in,
                saveLogin,
                loginBroadcastOperation,
                useHiveSigner: true,
                lastPath,
            };
            console.log('login:hivesigner', data);
            reallySubmit(data, afterLoginRedirectToWelcome);
        }
    };

    render() {
        if (!process.env.BROWSER) {
            return (
                <div className="row">
                    <div className="column">
                        <p>
                            loading
                            ...
                        </p>
                    </div>
                </div>
            );
        }
        if (this.state.isHiveSigner) {
            return (
                <div className="row">
                    <div className="column">
                        <p>{tt('g.loading')}</p>
                    </div>
                </div>
            );
        }
        if (this.state.cryptographyFailure) {
            return (
                <div className="row">
                    <div className="column">
                        <div className="callout alert">
                            <h4>{tt('loginform_jsx.cryptography_test_failed')}</h4>
                            <p>{tt('loginform_jsx.unable_to_log_you_in')}</p>
                            <p>
                                {tt('loginform_jsx.the_latest_versions_of')}
                                {' '}
                                <a href="https://www.google.com/chrome/">Chrome</a>
                                {' '}
                                {tt('g.and')}
                                {' '}
                                <a href="https://www.mozilla.org/en-US/firefox/new/">Firefox</a>
                                {' '}
                                {tt('loginform_jsx.are_well_tested_and_known_to_work_with', { APP_URL })}
                            </p>
                        </div>
                    </div>
                </div>
            );
        }

        if ($STM_Config.read_only_mode) {
            return (
                <div className="row">
                    <div className="column">
                        <div className="callout alert">
                            <p>{tt('loginform_jsx.due_to_server_maintenance')}</p>
                        </div>
                    </div>
                </div>
            );
        }

        const {
            walletUrl,
            showLoginWarning,
            loginBroadcastOperation,
            dispatchSubmit,
            reallySubmit,
            hideWarning,
            afterLoginRedirectToWelcome,
            msg,
        } = this.props;
        const {
            username,
            password,
            useKeychain,
            useHiveAuth,
            saveLogin,
            oauthFlow,
            oauthFlowLoading,
            oauthFlowError,
        } = this.state;

        const { valid, handleSubmit } = this.state.login;
        const submitting = this.state.login.submitting || this.state.isHiveSigner || this.state.isProcessingHiveAuth;
        const { usernameOnChange, onCancel /*qrReader*/ } = this;
        const disabled = submitting || !valid;
        const opType = loginBroadcastOperation ? loginBroadcastOperation.get('type') : null;
        let postType = '';
        if (opType === 'vote') {
            postType = tt('loginform_jsx.login_to_vote');
        } else if (opType === 'custom_json' && loginBroadcastOperation.getIn(['operation', 'id']) === 'follow') {
            postType = 'Login to Follow Users';
        } else if (loginBroadcastOperation) {
            // check for post or comment in operation
            postType = loginBroadcastOperation.getIn(['operation', 'title'])
                ? tt('loginform_jsx.login_to_post')
                : tt('g.confirm_password');
        }
        const title = postType ? postType : tt('g.login');
        const authType = /^vote|comment/.test(opType)
            ? tt('loginform_jsx.posting')
            : tt('loginform_jsx.active_or_owner');
        const submitLabel = showLoginWarning
            ? tt('loginform_jsx.continue_anyway')
            : loginBroadcastOperation
                ? tt('g.sign_in')
                : tt('g.login');
        let error = password.touched && password.error ? password.error : this.props.loginError;
        if (error === 'owner_login_blocked') {
            error = (
                <span>
                    {tt('loginform_jsx.this_password_is_bound_to_your_account_owner_key')}
                    {' '}
                    {tt('loginform_jsx.however_you_can_use_it_to')}
                    {tt('loginform_jsx.update_your_password')}
                    {' '}
                    {tt('loginform_jsx.to_obtain_a_more_secure_set_of_keys')}
                </span>
            );
        } else if (error === 'active_login_blocked') {
            error = <span>{tt('loginform_jsx.this_password_is_bound_to_your_account_active_key')}</span>;
        }
        let message = null;
        if (msg) {
            if (msg === 'accountcreated') {
                message = (
                    <div className="callout primary">
                        <p>{tt('loginform_jsx.you_account_has_been_successfully_created')}</p>
                    </div>
                );
            } else if (msg === 'passwordupdated') {
                message = (
                    <div className="callout primary">
                        <p>
                            {tt('loginform_jsx.password_update_succes', {
                                accountName: username.value,
                            })}
                        </p>
                    </div>
                );
            }
        }

        if (oauthFlowLoading) {
            message = (
                <div className="callout primary">
                    {tt('loginform_jsx.oauth_loading_message')}
                </div>
            );
        }

        if (oauthFlowError) {
            message = (
                <div className="callout alert">
                    {tt('loginform_jsx.oauth_error_message')}
                </div>
            );
        }

        if (oauthFlow) {
            message = (
                <div className="callout primary">

                    <div className="text-align-center">
                        {`${tt('loginform_jsx.oauth_info')} `}
                    </div>

                    {oauthFlow.clientName ? (
                        <div className="text-align-center">
                            {oauthFlow.clientUri ? (
                                <a href={oauthFlow.clientUri}>
                                    {oauthFlow.clientName}
                                </a>
                            ) : (
                                <>{oauthFlow.clientName}</>
                            )}
                        </div>
                    ) : null}

                    {oauthFlow.logoUri && (
                        <div className="oauth-client-logo">
                            <img
                                src={oauthFlow.logoUri}
                                alt="Client Application Logo"
                            />
                        </div>
                    )}

                </div>
            );
        }

        const password_info = !useKeychain.value && !useHiveAuth.value && checkPasswordChecksum(password.value) === false
            ? tt('loginform_jsx.password_info')
            : null;
        const titleText = (
            <h3>
                {tt('loginform_jsx.returning_users')}
                <span className="OpAction">{title}</span>
            </h3>
        );

        /*
                const signupLink = (
                    <div className="sign-up">
                        <hr />
                        <p>
                            {tt('loginform_jsx.join_our')} <em>{tt('loginform_jsx.amazing_community')}</em>
                            {tt('loginform_jsx.to_comment_and_reward_others')}
                        </p>
                        <button type="button" className="button hollow" onClick={this.SignUp}>
                            {tt('loginform_jsx.sign_up_get_hive')}
                        </button>
                    </div>
                );
         */

        const form = (
            <form
                onSubmit={handleSubmit(({ data }) => {
                    // bind redux-form to react-redux
                    console.log('Login\tdispatchSubmit', useHiveAuth.value);
                    this.props.clearError();

                    if (useHiveAuth.value) {
                        this.setState({ isProcessingHiveAuth: true });
                    }

                    return dispatchSubmit(
                        data,
                        useKeychain.value,
                        useHiveAuth.value,
                        loginBroadcastOperation,
                        afterLoginRedirectToWelcome
                    );
                })}
                onChange={this.props.clearError}
                method="post"
            >
                <div className="input-group">
                    <span className="input-group-label">@</span>
                    <input
                        className="input-group-field"
                        type="text"
                        required
                        placeholder={tt('loginform_jsx.enter_your_username')}
                        ref="username"
                        {...username.props}
                        onChange={usernameOnChange}
                        autoComplete="on"
                        disabled={submitting}
                    />
                </div>
                {username.touched && username.blur && username.error ? (
                    <div className="error">
                        {username.error}
                        &nbsp;
                    </div>
                ) : null}

                {useKeychain.value || useHiveAuth.value ? (
                    <div>
                        {error && (
                            <div className="error">
                                {error}
                                &nbsp;
                            </div>
                        )}
                    </div>
                ) : (
                    <div>
                        <input
                            type="password"
                            required
                            ref="pw"
                            placeholder={tt('loginform_jsx.password_or_wif')}
                            {...password.props}
                            autoComplete="on"
                            disabled={submitting}
                        />
                        {error && (
                            <div className="error">
                                {error}
                                &nbsp;
                            </div>
                        )}
                        {error && password_info && (
                            <div className="warning">
                                {password_info}
                                &nbsp;
                            </div>
                        )}
                    </div>
                )}
                {loginBroadcastOperation && (
                    <div>
                        <div className="info">
                            {tt('loginform_jsx.this_operation_requires_your_key_or_master_password', { authType })}
                        </div>
                    </div>
                )}
                {hasCompatibleKeychain() && (
                    <div>
                        <label className="LoginForm__save-login" htmlFor="useKeychain">
                            <input
                                id="useKeychain"
                                type="checkbox"
                                ref="pw"
                                {...useKeychain.props}
                                onChange={this.useKeychainToggle}
                                disabled={submitting || oauthFlow}
                            />
                            &nbsp;
                            <img src="/images/hivekeychain.png" alt="Hive Keychain" width="16" />
                            &nbsp;
                            {tt('loginform_jsx.use_keychain')}
                        </label>
                    </div>
                )}
                <div>
                    <label className="LoginForm__save-login" htmlFor="useHiveAuth">
                        <input
                            id="useHiveAuth"
                            type="checkbox"
                            ref="pw"
                            {...useHiveAuth.props}
                            onChange={this.useHiveAuthToggle}
                            disabled={(!hasError && submitting) || oauthFlow}
                        />
                        &nbsp;
                        <img src="/images/hiveauth.png" alt="HiveAuth" width="16" />
                        &nbsp;
                        {tt('loginform_jsx.use_hiveauth')}
                    </label>
                </div>
                <div>
                    <label className="LoginForm__save-login" htmlFor="saveLogin">
                        <input
                            id="saveLogin"
                            type="checkbox"
                            ref="pw"
                            {...saveLogin.props}
                            onChange={this.saveLoginToggle}
                            disabled={submitting}
                        />
                        &nbsp;
                        {tt('loginform_jsx.keep_me_logged_in')}
                    </label>
                </div>
                <div className="login-modal-buttons">
                    <br />
                    <button type="submit" disabled={submitting || disabled} className="button">
                        {submitLabel}
                    </button>
                    {this.props.onCancel && (
                        <button
                            type="button"
                            disabled={submitting}
                            className="button hollow float-right"
                            onClick={onCancel}
                        >
                            {tt('g.cancel')}
                        </button>
                    )}
                </div>
                <div className="hiveauth_info">
                    <div id="hiveauth-instructions" className="hiveauth_instructions" />
                    <a
                        href="#"
                        id="hiveauth-qr-link"
                        className="hiveauth_qr"
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        <canvas id="hiveauth-qr" />
                    </a>
                </div>
                {/*signupLink*/}
            </form>
        );

        const loginWarningTitleText = <h3>{tt('loginform_jsx.login_warning_title')}</h3>;

        const loginWarningForm = (
            <form
                onSubmit={handleSubmit(() => {
                    console.log('Login\treallySubmit');
                    const data = {
                        username: username.value,
                        password: password.value,
                        saveLogin: saveLogin.value,
                        loginBroadcastOperation,
                    };
                    reallySubmit(data, afterLoginRedirectToWelcome);
                })}
                method="post"
            >
                <p>{tt('loginform_jsx.login_warning_body')}</p>
                <div>
                    <PdfDownload
                        name={username.value}
                        password={password.value}
                        widthInches={8.5}
                        heightInches={11.0}
                        label="Download a PDF with keys and instructions"
                    />
                    <a href={`${walletUrl}/@${username.value}/permissions`} target="_blank" rel="noopener noreferrer">
                        {tt('loginform_jsx.login_warning_link_text')}
                    </a>
                </div>
                <div className="login-modal-buttons">
                    <br />
                    <button
                        type="submit"
                        disabled={submitting}
                        className="button"
                        onClick={(e) => {
                            e.preventDefault();
                            console.log('Login\thideWarning');
                            hideWarning();
                        }}
                    >
                        {tt('g.try_again')}
                    </button>
                </div>
            </form>
        );

        const moreLoginMethods = (
            <div className="row buttons login-alternative-methods">
                <div className="column">
                    <a role="link" id="btn-hivesigner" className="button" onClick={this.onClickHiveSignerBtn} disabled={submitting}>
                        <img src="/images/hivesigner.svg" alt="Hive Signer" />
                    </a>
                </div>
            </div>
        );

        return (
            <div className="LoginForm">
                <div className="row">
                    <div className="column">
                        {message}
                        {!oauthFlowLoading && !oauthFlowError && (
                            <div>
                                {showLoginWarning ? loginWarningTitleText : titleText}
                                {showLoginWarning ? loginWarningForm : form}
                            </div>
                        )}
                    </div>
                </div>
                {!oauthFlowLoading && !oauthFlowError && (
                    <div>
                        <div className="divider">
                            <span>{tt('loginform_jsx.more_login_methods')}</span>
                        </div>
                        <br />
                        {moreLoginMethods}
                    </div>
                )}
            </div>
        );
    }
}

let hasError;
let saveLoginDefault = true;
if (process.env.BROWSER) {
    const s = localStorage.getItem('saveLogin');
    if (s === 'no') saveLoginDefault = false;
}

function urlAccountName() {
    let suggestedAccountName = '';
    const account_match = window.location.hash.match(/account=([\w\d\-.]+)/);
    if (account_match && account_match.length > 1) suggestedAccountName = account_match[1];
    return suggestedAccountName;
}

function checkPasswordChecksum(password) {
    // A Steemit generated password is a WIF prefixed with a P ..
    // It is possible to login directly with a WIF
    const wif = /^P/.test(password) ? password.substring(1) : password;

    if (!/^5[HJK].{45,}/i.test(wif)) {
        // 51 is the wif length
        // not even close
        return undefined;
    }

    return PrivateKey.isWif(wif);
}
export default connect(
    // mapStateToProps
    (state) => {
        const walletUrl = state.app.get('walletUrl');
        const showLoginWarning = state.user.get('show_login_warning');
        const loginError = state.user.get('login_error');
        const currentUser = state.user.get('current');
        const loginBroadcastOperation = state.user.get('loginBroadcastOperation');
        const initialValues = {
            useKeychain: !!hasCompatibleKeychain(),
            useHiveAuth: false,
            saveLogin: saveLoginDefault,
        };

        // The username input has a value prop, so it should not use initialValues
        const initialUsername = currentUser && currentUser.has('username') ? currentUser.get('username') : urlAccountName();
        const loginDefault = state.user.get('loginDefault');
        if (loginDefault) {
            const { username, authType } = loginDefault.toJS();
            if (username && authType) initialValues.username = username + '/' + authType;
        } else if (initialUsername) {
            initialValues.username = initialUsername;
        }
        const offchainUser = state.offchain.get('user');
        if (!initialUsername && offchainUser && offchainUser.get('account')) {
            initialValues.username = offchainUser.get('account');
        }
        let msg = '';
        const msg_match = window.location.hash.match(/msg=([\w]+)/);
        if (msg_match && msg_match.length > 1) msg = msg_match[1];
        hasError = !!loginError;
        return {
            walletUrl,
            showLoginWarning,
            loginError,
            loginBroadcastOperation,
            initialValues,
            initialUsername,
            msg,
            offchain_user: state.offchain.get('user'),
        };
    },

    // mapDispatchToProps
    (dispatch) => ({
        dispatchSubmit: (data, useKeychain, useHiveAuth, loginBroadcastOperation, afterLoginRedirectToWelcome) => {
            console.log('HiveAuth', useHiveAuth);
            const { password, saveLogin } = data;
            const username = data.username.trim().toLowerCase();
            if (loginBroadcastOperation) {
                const {
                    type, operation, successCallback, errorCallback
                } = loginBroadcastOperation.toJS();
                dispatch(
                    transactionActions.broadcastOperation({
                        type,
                        operation,
                        username,
                        password,
                        useKeychain,
                        useHiveAuth,
                        successCallback,
                        errorCallback,
                    })
                );
                dispatch(
                    userActions.usernamePasswordLogin({
                        username,
                        password,
                        useKeychain,
                        useHiveAuth,
                        saveLogin,
                        afterLoginRedirectToWelcome,
                        operationType: type,
                    })
                );

                serverApiRecordEvent('SignIn', type);

                dispatch(userActions.closeLogin());
            } else {
                dispatch(
                    userActions.checkKeyType({
                        username,
                        password,
                        useKeychain,
                        useHiveAuth,
                        saveLogin,
                        afterLoginRedirectToWelcome,
                    })
                );
            }
        },
        reallySubmit: (
            {
                username,
                password,
                saveLogin,
                loginBroadcastOperation,
                access_token,
                expires_in,
                useHiveSigner,
                lastPath,
            },
            afterLoginRedirectToWelcome
        ) => {
            const { type } = loginBroadcastOperation ? loginBroadcastOperation.toJS() : {};

            serverApiRecordEvent('SignIn', type);
            console.log('really submit');
            dispatch(
                userActions.usernamePasswordLogin({
                    username,
                    password,
                    access_token,
                    expires_in,
                    lastPath,
                    useHiveSigner,
                    saveLogin,
                    afterLoginRedirectToWelcome,
                })
            );
        },
        hideWarning: () => {
            dispatch(userActions.hideLoginWarning());
        },
        clearError: () => {
            if (hasError) dispatch(userActions.loginError({ error: null }));
        },
        qrReader: (dataCallback) => {
            dispatch(
                globalActions.showDialog({
                    name: 'qr_reader',
                    params: { handleScan: dataCallback },
                })
            );
        },
    })
)(LoginForm);
