const crypto = require('crypto');
const JWT = require('jsonwebtoken');
const { promisify } = require('util');
const Email = require('./../utils/email');
const User = require('./../models/usersmodel');
const AppError = require('./../utils/appError');
const catchAsyncError = require('./../utils/catchAsyncError');
//-----------------JWT-----------------------//
function signToken(id) {
  return JWT.sign({ id: id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN
  });
}
function createAndSendToken(user, statusCode, req, res) {
  const token = signToken(user._id);

  // remove password from  user data output
  user.password = undefined;

  // Send cookie
  res.cookie('jwt', token, {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure:
      process.env.NODE_ENV === 'production' &&
      (req.secure || req.headers['x-forwarded-proto'] === 'https')
  });

  // Send response
  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user
    }
  });
}
//------------handler functions ------------//
//-------------- Sign up
exports.signup = catchAsyncError(async (req, res, next) => {
  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    role: req.body.role
  });
  const url = `${req.protocol}://${req.get('host')}/me`;
  await new Email(newUser, url).sendWelcome();

  createAndSendToken(newUser, 201, req, res);
});
//-------------- Login
exports.login = catchAsyncError(async (req, res, next) => {
  const { email, password } = req.body;
  // 1) Check if email and password exist
  if (!email && !password)
    return next(new AppError('Please provide email and password', 400));
  if (!email) return next(new AppError('Please provide email', 400));
  if (!password) return next(new AppError('Please provide password', 400));

  // 2) Check if user exists && password is correct
  const user = await User.findOne({ email }).select('+password');
  // const correct = await user.correctPassword(password, user.password);
  // console.log(user.password)
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Incorrect email or password', 401));
  }
  console.log(user);
  // 3) If everything ok, send token to client
  createAndSendToken(user, 200, req, res);
});
//-------------- Logout
exports.logout = (req, res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 1 * 500),
    httpOnly: true
  });
  res.status(200).json({ status: 'success' });
};
//-------------- IsLogin
exports.isLogin = async (req, res, next) => {
  // 1) verify token
  if (req.cookies.jwt) {
    try {
      const decoded = await promisify(JWT.verify)(
        req.cookies.jwt,
        process.env.JWT_SECRET
      );
      // 2) Check if user still exists
      const currentUser = await User.findById(decoded.id);

      if (!currentUser) {
        return next();
      }

      // 3) Check if user changed password after the token was issued
      if (currentUser.isPasswordChanged(decoded.iat)) {
        return next();
      }

      // THERE IS A LOGGED IN USER
      res.locals.user = currentUser;
      req.isLogin = true;
      return next();
    } catch (err) {
      return next();
    }
  }
  return next();
};
//-------------- Update Password
exports.updatePassword = catchAsyncError(async (req, res, next) => {
  // 1) Get user from collection
  const user = await User.findById(req.user.id).select('+password');
  // 2) Check if Posted current password is correct (Same as password in DB)
  if (!(await user.correctPassword(req.body.currentPassword, user.password))) {
    return next(new AppError('Your current password is wrong', 401));
  }
  // 3) If so, update password
  user.password = req.body.newPassword;
  user.passwordConfirm = req.body.newPasswordConfirm;
  await user.save();
  // 4) Log user in, send JWT
  createAndSendToken(user, 200, req, res);
});
// ---------------password Reset-----------------//
//-------------- Forget password
exports.forgotPassword = catchAsyncError(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with email address', 404));
  }
  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });

  // 3) Send it to user's email
  try {
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/resetPassword/${resetToken}`;

    await new Email(user, resetURL).sendPasswordReset();

    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!'
    });
  } catch {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return next(
      new AppError('There was an error sending the email. Try again later!'),
      500
    );
  }
});
//-------------- Reset password
exports.resetPassword = catchAsyncError(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() }
  });

  // 2) If token has not expired, and there is user, set the new password
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }
  // 3) Update changedPasswordAt property for the user
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // 4) Log the user in, send JWT
  createAndSendToken(user, 200, req, res);
});
// ---------------protecting routes-----------------//
exports.protect = catchAsyncError(async (req, res, next) => {
  // 1) Getting token and check of it's there
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token)
    return next(
      new AppError('You are not login! Please login to get access.', 401)
    );

  // 2) Verification token
  const decoded = await promisify(JWT.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user still exists
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        401
      )
    );
  }

  // 4) Check if user changed password after the token was issued
  if (currentUser.isPasswordChanged(decoded.iat)) {
    return next(
      new AppError('User recently changed password! Please log in again.', 401)
    );
  }

  // Grant access to protected route
  req.user = currentUser;
  res.locals.user = currentUser;
  next();
});
// ---------------restricting to roles-----------------//
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }
    next();
  };
};
